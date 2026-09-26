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

test("generateToken includes restaurantId when the employee belongs to one", () => {
  const id = oid();
  const restaurantId = oid();
  const decoded = verifyToken(generateToken({ _id: id, position: "admin", restaurantId }));
  assert.equal(decoded.restaurantId, restaurantId.toString());
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
  const body = { title: "Pizza", price: 10, numSold: 9999 };
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
