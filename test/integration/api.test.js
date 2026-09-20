// Integration tests against a real (in-memory) MongoDB via
// mongodb-memory-server. These download a mongod binary on first run and
// so require outbound network access - run with `npm run test:integration`
// separately from the network-free unit suite (`npm test`).
import test from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.JWT_SECRET = "test-secret-for-integration-suite";

let mongod;
let app;
let request;
let Employee;
let generateToken;
let hashPassword;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_DB_URL = mongod.getUri();
  process.env.PORT = "0";
  ({ default: request } = await import("supertest"));
  ({ default: app } = await import("../../index.js"));
  ({ default: Employee } = await import("../../models/employee.modal.js"));
  ({ generateToken, hashPassword } = await import("../../utils/index.js"));
});

test.after(async () => {
  await mongod?.stop();
});

const registerUser = (overrides = {}) =>
  request(app)
    .post("/api/v1/users")
    .send({
      username: "alice1234",
      email: "alice@example.com",
      password: "supersecret1",
      ...overrides,
    });

// There is intentionally no public endpoint to create the first admin
// (employee CRUD is entirely admin-gated) - a real deployment seeds it
// out-of-band (DB script), which this fixture mirrors directly against
// the model instead of going through the gated HTTP endpoint.
const seedAdmin = async (overrides = {}) => {
  const employee = await Employee.create({
    employee: "seed_admin",
    email: "seed_admin@example.com",
    password: await hashPassword("supersecret1"),
    position: "admin",
    ...overrides,
  });
  return generateToken(employee);
};

test("registering and fetching a user never returns a password field, at any nesting depth", async () => {
  const reg = await registerUser();
  assert.equal(reg.status, 201);
  assert.equal(JSON.stringify(reg.body).includes("password"), false);

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ username: "alice1234", password: "supersecret1" });
  assert.equal(login.status, 200);
  const token = login.headers.authorization?.split(" ")[1];
  assert.ok(token, "login should return a bearer token");
  assert.equal(JSON.stringify(login.body).includes("password"), false);

  const me = await request(app)
    .get("/api/v1/auth/user")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(me.status, 200);
  assert.equal(JSON.stringify(me.body).includes("password"), false);
});

test("protected routes 401 without a token and 403 with the wrong role", async () => {
  const reg = await registerUser({
    username: "carol5678",
    email: "carol@example.com",
  });
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ username: "carol5678", password: "supersecret1" });
  const token = login.headers.authorization.split(" ")[1];

  const noAuth = await request(app).get("/api/v1/employee");
  assert.equal(noAuth.status, 401);

  const wrongRole = await request(app)
    .get("/api/v1/employee")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(wrongRole.status, 403);
});

test("mass assignment: numSold cannot be set through the update body", async () => {
  const token = await seedAdmin({ employee: "admin_bob" });

  const created = await request(app)
    .post("/api/v1/menu-items")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title: "Test Pizza",
      description: "desc",
      price: 10,
      image: "x.png",
      category: "food",
    });
  assert.equal(created.status, 201);
  assert.equal(created.body.numSold, 0);

  const updated = await request(app)
    .put(`/api/v1/menu-items/${created.body._id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ numSold: 9999 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.numSold, 0);
});

test("numSold stays correct under concurrent order creation", async () => {
  const adminToken = await seedAdmin({ employee: "admin_dana" });

  const item = await request(app)
    .post("/api/v1/menu-items")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      title: "Concurrent Burger",
      description: "desc",
      price: 5,
      image: "x.png",
      category: "food",
    });

  const reg = await registerUser({
    username: "concurrentUser",
    email: "concurrent@example.com",
  });
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ username: "concurrentUser", password: "supersecret1" });
  const userToken = login.headers.authorization.split(" ")[1];

  const N = 10;
  await Promise.all(
    Array.from({ length: N }, () =>
      request(app)
        .post("/api/v1/orders")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ menuItems: [{ product: item.body._id, quantity: 1 }] })
    )
  );

  const refreshed = await request(app)
    .get(`/api/v1/menu-items/${item.body._id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(refreshed.body.numSold, N);
});

test("negative/fractional quantity is rejected", async () => {
  const reg = await registerUser({
    username: "erin4321",
    email: "erin@example.com",
  });
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ username: "erin4321", password: "supersecret1" });
  const token = login.headers.authorization.split(" ")[1];

  const res = await request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({
      menuItems: [{ product: "507f1f77bcf86cd799439011", quantity: -1 }],
    });
  assert.equal(res.status, 400);
});
