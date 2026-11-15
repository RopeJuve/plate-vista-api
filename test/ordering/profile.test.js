process.env.JWT_SECRET = "test-secret-profile";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateToken, hashPassword } from "../../src/shared/auth.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import { setImageDestroyer } from "../../src/modules/restaurants/profile.js";

const CLOUDINARY = {
  CLOUDINARY_CLOUD_NAME: "demo",
  CLOUDINARY_API_KEY: "key",
  CLOUDINARY_API_SECRET: "secret",
};

let mongod;
let app;
let request;
let passwordHash;
let destroyed;

const LEGAL = {
  legalName: "Puzzle GmbH",
  address: { street: "Hauptstraße 1", zip: "10115", city: "Berlin", country: "DE" },
  taxNumber: "27/123/45678",
};

const staffOf = (restaurant, position) =>
  Employee.create({
    restaurantId: restaurant._id,
    employee: `${position}-${randomUUID().slice(0, 8)}`,
    email: `${position}-${randomUUID().slice(0, 8)}@example.com`,
    password: passwordHash,
    position,
    role: position,
  });

const place = async (fields = {}) => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({ name: `R${suffix}`, slug: `r-${suffix}`, legal: LEGAL, ...fields });
  const as = (who) => (method, path) =>
    request(app)[method](`/api/v1/restaurant${path}`).set("Authorization", `Bearer ${generateToken(who)}`);
  return {
    restaurant,
    asOwner: as(await staffOf(restaurant, "owner")),
    asAdmin: as(await staffOf(restaurant, "admin")),
    asKitchen: as(await staffOf(restaurant, "kitchen")),
  };
};

const logoOf = (restaurant, name = "a1") =>
  `https://res.cloudinary.com/demo/image/upload/v1712/plate-vista/${restaurant._id}/logo/${name}.png`;

const HOURS = { mon: [{ open: "11:00", close: "19:00" }], fri: [{ open: "18:00", close: "02:00" }] };

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_DB_URL = mongod.getUri();
  await connectToDatabase();
  ({ default: request } = await import("supertest"));
  ({ default: app } = await import("../../src/app.js"));
  passwordHash = await hashPassword("supersecret1");
}, { timeout: 120000 });

test.beforeEach(() => {
  Object.assign(process.env, CLOUDINARY);
  destroyed = [];
  setImageDestroyer(async (url) => {
    destroyed.push(url);
  });
});

test.after(async () => {
  setImageDestroyer(null);
  await disconnectDatabase();
  await mongod?.stop();
});

test("the public profile of a new restaurant shows its name and legal address, nothing else", async () => {
  const { restaurant } = await place();
  const res = await request(app).get(`/api/v1/r/${restaurant.slug.toUpperCase()}/profile`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    name: restaurant.name,
    logoUrl: null,
    address: { street: "Hauptstraße 1", zip: "10115", city: "Berlin" },
    openingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    timezone: "Europe/Berlin",
  });
  assert.match(res.headers["cache-control"], /max-age=60/);
});

test("the public profile is not found for unknown or inactive restaurants", async () => {
  assert.equal((await request(app).get("/api/v1/r/no-such-place/profile")).status, 404);
  const { restaurant } = await place({ status: "inactive" });
  assert.equal((await request(app).get(`/api/v1/r/${restaurant.slug}/profile`)).status, 404);
});

test("owner and admin read and save the profile; guests then see it", async () => {
  const { restaurant, asOwner, asAdmin } = await place();

  const before = await asAdmin("get", "/profile");
  assert.equal(before.status, 200);
  assert.equal(before.body.usesLegalAddress, true);
  assert.deepEqual(before.body.legalAddress, { street: "Hauptstraße 1", zip: "10115", city: "Berlin" });

  const address = { street: "Neben dem Mühlweg 26", zip: "65474", city: "Bischofsheim" };
  const saved = await asOwner("put", "/profile").send({ logoUrl: logoOf(restaurant), address, openingHours: HOURS });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.usesLegalAddress, false);
  assert.deepEqual(saved.body.address, address);
  assert.deepEqual(saved.body.openingHours.fri, HOURS.fri);

  const pub = await request(app).get(`/api/v1/r/${restaurant.slug}/profile`);
  assert.equal(pub.body.logoUrl, logoOf(restaurant));
  assert.deepEqual(pub.body.address, address);
  assert.deepEqual(pub.body.openingHours.mon, HOURS.mon);

  const cleared = await asAdmin("put", "/profile").send({ logoUrl: null, address: null, openingHours: {} });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.usesLegalAddress, true);
  const after = await request(app).get(`/api/v1/r/${restaurant.slug}/profile`);
  assert.equal(after.body.address.city, "Berlin");
  assert.equal(after.body.logoUrl, null);
});

test("kitchen staff cannot read or change the profile", async () => {
  const { asKitchen } = await place();
  assert.equal((await asKitchen("get", "/profile")).status, 403);
  const res = await asKitchen("put", "/profile").send({});
  assert.equal(res.status, 403);
});

test("invalid profiles are refused with field errors", async () => {
  const { asOwner } = await place();
  const res = await asOwner("put", "/profile").send({
    address: { street: "A 1", zip: "123", city: "X" },
    openingHours: { tue: [{ open: "11:00", close: "15:00" }, { open: "14:00", close: "22:00" }] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION");
  assert.ok(res.body.details.fields["address.zip"]);
  assert.ok(res.body.details.fields["openingHours.tue"]);
});

test("a logo from anywhere but this restaurant's logo folder is refused", async () => {
  const { restaurant, asOwner } = await place();
  const other = await Restaurant.create({ name: "Other", slug: `o-${randomUUID().slice(0, 8)}` });
  for (const logoUrl of [
    logoOf(other),
    "https://example.com/logo.png",
    logoOf(restaurant).replace(".png", ".svg"),
  ]) {
    const res = await asOwner("put", "/profile").send({ logoUrl });
    assert.equal(res.status, 400, logoUrl);
    assert.ok(res.body.details.fields.logoUrl, logoUrl);
  }
});

test("replacing or removing the logo deletes the old image; keeping it deletes nothing", async () => {
  const { restaurant, asOwner } = await place();
  await asOwner("put", "/profile").send({ logoUrl: logoOf(restaurant, "first") });
  assert.deepEqual(destroyed, []);

  await asOwner("put", "/profile").send({ logoUrl: logoOf(restaurant, "first"), openingHours: HOURS });
  assert.deepEqual(destroyed, []);

  await asOwner("put", "/profile").send({ logoUrl: logoOf(restaurant, "second") });
  assert.deepEqual(destroyed, [logoOf(restaurant, "first")]);

  await asOwner("put", "/profile").send({ logoUrl: null });
  assert.deepEqual(destroyed, [logoOf(restaurant, "first"), logoOf(restaurant, "second")]);
});

test("a failed image deletion does not fail the save", async () => {
  const { restaurant, asOwner } = await place();
  await asOwner("put", "/profile").send({ logoUrl: logoOf(restaurant, "first") });
  setImageDestroyer(async () => {
    throw new Error("cloudinary down");
  });
  const res = await asOwner("put", "/profile").send({ logoUrl: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.logoUrl, null);
});

test("the logo upload signature is for this restaurant's logo folder", async () => {
  const { restaurant, asAdmin, asKitchen } = await place();
  const res = await asAdmin("post", "/profile/logo-upload-signature");
  assert.equal(res.status, 200);
  assert.equal(res.body.folder, `plate-vista/${restaurant._id}/logo`);
  assert.equal(res.body.allowedFormats, "jpg,png,webp");
  assert.equal(res.body.cloudName, "demo");
  assert.equal(res.body.apiSecret, undefined);
  assert.equal((await asKitchen("post", "/profile/logo-upload-signature")).status, 403);

  delete process.env.CLOUDINARY_API_SECRET;
  assert.equal((await asAdmin("post", "/profile/logo-upload-signature")).status, 503);
});
