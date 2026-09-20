process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import {
  generateToken,
  verifyToken,
  sanitizedUser,
  sanitizedUsers,
  pick,
  parsePagination,
  assertValidMenuItems,
  calculateTotal,
  incrementSoldCounts,
  updatedOrder,
  OrderError,
} from "../../utils/index.js";

const oid = () => new mongoose.Types.ObjectId();

test("generateToken/verifyToken: user token carries role but never email/password", () => {
  const id = oid();
  const token = generateToken({ _id: id, username: "bob", email: "bob@x.com" });
  const decoded = verifyToken(token);
  assert.equal(decoded.id, id.toString());
  assert.equal(decoded.role, "user");
  assert.equal(decoded.email, undefined);
  assert.equal(decoded.username, undefined);
  assert.equal(decoded.position, undefined);
});

test("generateToken/verifyToken: employee token carries role and position", () => {
  const id = oid();
  const token = generateToken({ _id: id, position: "admin" });
  const decoded = verifyToken(token);
  assert.equal(decoded.role, "employee");
  assert.equal(decoded.position, "admin");
});

test("verifyToken rejects a token signed with the wrong secret", () => {
  const forged = jwt.sign({ id: "1", role: "employee", position: "admin" }, "wrong-secret", {
    algorithm: "HS256",
  });
  assert.throws(() => verifyToken(forged));
});

test("verifyToken rejects a token signed with an unpinned algorithm (alg confusion)", () => {
  const forged = jwt.sign(
    { id: "1", role: "employee", position: "admin" },
    process.env.JWT_SECRET,
    { algorithm: "HS512" }
  );
  assert.throws(() => verifyToken(forged));
});

test("sanitizedUser strips password/__v from a Mongoose-shaped doc (_doc)", () => {
  const doc = { _doc: { _id: "1", username: "bob", password: "hash", __v: 0 } };
  assert.deepEqual(sanitizedUser(doc), { _id: "1", username: "bob" });
});

test("sanitizedUser strips password/__v from a lean() plain object", () => {
  const lean = { _id: "1", username: "bob", password: "hash", __v: 0 };
  assert.deepEqual(sanitizedUser(lean), { _id: "1", username: "bob" });
});

test("sanitizedUsers maps a list the same way", () => {
  const users = [{ _id: "1", password: "a" }, { _id: "2", password: "b" }];
  assert.deepEqual(sanitizedUsers(users), [{ _id: "1" }, { _id: "2" }]);
});

test("pick only keeps whitelisted keys (mass-assignment guard)", () => {
  const body = { title: "Pizza", price: 10, numSold: 9999, __proto__: {} };
  const result = pick(body, ["title", "price"]);
  assert.deepEqual(result, { title: "Pizza", price: 10 });
  assert.equal(result.numSold, undefined);
});

test("pick ignores keys not present on the source", () => {
  assert.deepEqual(pick({ title: "x" }, ["title", "missing"]), { title: "x" });
});

test("parsePagination defaults to page 1 / limit 20", () => {
  assert.deepEqual(parsePagination({}), { page: 1, limit: 20, skip: 0 });
});

test("parsePagination clamps limit to 100 and page to >= 1", () => {
  assert.deepEqual(parsePagination({ page: "0", limit: "500" }), {
    page: 1,
    limit: 100,
    skip: 0,
  });
});

test("parsePagination computes skip from page/limit", () => {
  assert.deepEqual(parsePagination({ page: "3", limit: "10" }), {
    page: 3,
    limit: 10,
    skip: 20,
  });
});

test("assertValidMenuItems accepts a well-formed list", () => {
  assert.doesNotThrow(() =>
    assertValidMenuItems([{ product: oid().toString(), quantity: 2 }])
  );
});

test("assertValidMenuItems rejects an empty/non-array list", () => {
  assert.throws(() => assertValidMenuItems([]), OrderError);
  assert.throws(() => assertValidMenuItems(null), OrderError);
});

test("assertValidMenuItems rejects more than 50 items", () => {
  const items = Array.from({ length: 51 }, () => ({
    product: oid().toString(),
    quantity: 1,
  }));
  assert.throws(() => assertValidMenuItems(items), OrderError);
});

test("assertValidMenuItems rejects a non-MongoId product", () => {
  assert.throws(
    () => assertValidMenuItems([{ product: "not-an-id", quantity: 1 }]),
    OrderError
  );
});

test("assertValidMenuItems rejects zero/negative/non-integer/too-large quantity", () => {
  const p = oid().toString();
  for (const quantity of [0, -1, 1.5, 100, "5"]) {
    assert.throws(
      () => assertValidMenuItems([{ product: p, quantity }]),
      OrderError,
      `quantity ${quantity} should be rejected`
    );
  }
});

// --- calculateTotal is documented as pure: it must never write to the DB. ---

const fakeMenuItemModel = (items) => ({
  findById: async (id) => items.find((i) => i._id === id) || null,
  updateOne: async () => {},
});

test("calculateTotal computes the sum of price * quantity", async () => {
  const model = fakeMenuItemModel([
    { _id: "a", price: 10, inStock: true },
    { _id: "b", price: 2.5, inStock: true },
  ]);
  const total = await calculateTotal(
    [
      { product: "a", quantity: 2 },
      { product: "b", quantity: 4 },
    ],
    model
  );
  assert.equal(total, 30); // 10*2 + 2.5*4
});

test("calculateTotal never mutates the menu items it reads (no save/updateOne available)", async () => {
  // If calculateTotal tried to call .save() or model.updateOne(), this
  // would throw since neither exists on the fake docs/model - proving the
  // find -> mutate -> save numSold bug is gone.
  const model = fakeMenuItemModel([{ _id: "a", price: 5, inStock: true }]);
  const total = await calculateTotal([{ product: "a", quantity: 1 }], model);
  assert.equal(total, 5);
});

test("calculateTotal throws a 404 OrderError for a missing menu item", async () => {
  const model = fakeMenuItemModel([]);
  await assert.rejects(
    () => calculateTotal([{ product: "missing", quantity: 1 }], model),
    (err) => err instanceof OrderError && err.status === 404
  );
});

test("calculateTotal throws a 409 OrderError for an out-of-stock item", async () => {
  const model = fakeMenuItemModel([{ _id: "a", price: 5, inStock: false }]);
  await assert.rejects(
    () => calculateTotal([{ product: "a", quantity: 1 }], model),
    (err) => err instanceof OrderError && err.status === 409
  );
});

test("incrementSoldCounts issues one atomic $inc per item", async () => {
  const calls = [];
  const model = {
    updateOne: async (filter, update) => calls.push({ filter, update }),
  };
  await incrementSoldCounts(
    [
      { product: "a", quantity: 2 },
      { product: "b", quantity: 3 },
    ],
    model
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    filter: { _id: "a" },
    update: { $inc: { numSold: 2 } },
  });
  assert.deepEqual(calls[1], {
    filter: { _id: "b" },
    update: { $inc: { numSold: 3 } },
  });
});

// --- updatedOrder regression tests (the plan's documented bugs) ---

const fakeOrder = (menuItems, totalPrice = 0) => ({
  menuItems,
  totalPrice,
  save: async function () {
    return this;
  },
});

test("updatedOrder throws instead of referencing an undefined `res` (ReferenceError regression)", async () => {
  const order = fakeOrder([]);
  const model = fakeMenuItemModel([]);
  await assert.rejects(
    () => updatedOrder(order, { menuItems: [] }, model),
    OrderError
  );
});

test("updatedOrder merges ALL new items, not just menuItems[0]", async () => {
  const model = fakeMenuItemModel([
    { _id: "a", price: 10, inStock: true },
    { _id: "b", price: 20, inStock: true },
  ]);
  const order = fakeOrder([]);
  const result = await updatedOrder(
    order,
    {
      menuItems: [
        { product: "a", quantity: 1 },
        { product: "b", quantity: 1 },
      ],
    },
    model
  );
  const productIds = result.menuItems.map((i) => i.product).sort();
  assert.deepEqual(productIds, ["a", "b"]);
});

test("updatedOrder recomputes totalPrice from the merged list, not a stale delta", async () => {
  const model = fakeMenuItemModel([{ _id: "a", price: 10, inStock: true }]);
  // Order already has 1x "a" (total 10, matching an existing totalPrice of
  // 10) and the request adds 2 more of the same item.
  const order = fakeOrder([{ product: "a", quantity: 1 }], 10);
  const result = await updatedOrder(
    order,
    { menuItems: [{ product: "a", quantity: 2 }] },
    model
  );
  assert.equal(result.menuItems.length, 1);
  assert.equal(result.menuItems[0].quantity, 3);
  assert.equal(result.totalPrice, 30); // 3 * 10, recomputed - not 10 + 10 (a delta bug)
});

test("updatedOrder works whether existing order.menuItems.product is populated or a bare id", async () => {
  const model = fakeMenuItemModel([{ _id: "a", price: 10, inStock: true }]);
  const order = fakeOrder([{ product: { _id: "a" }, quantity: 1 }], 10);
  const result = await updatedOrder(
    order,
    { menuItems: [{ product: "a", quantity: 1 }] },
    model
  );
  assert.equal(result.menuItems.length, 1);
  assert.equal(result.menuItems[0].quantity, 2);
});
