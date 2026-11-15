import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { profileSchema, WEEKDAYS } from "../../src/modules/restaurants/profile.schemas.js";
import {
  isOwnLogoUrl,
  serializeProfile,
  serializePublicProfile,
} from "../../src/modules/restaurants/profile.js";
import { destroyImage, logoFolder, publicIdFromUrl, signLogoUpload } from "../../src/shared/cloudinary.js";

const noHours = () => Object.fromEntries(WEEKDAYS.map((day) => [day, []]));

const valid = () => ({
  logoUrl: null,
  address: { street: "Neben dem Mühlweg 26", zip: "65474", city: "Bischofsheim" },
  openingHours: { ...noHours(), mon: [{ open: "11:00", close: "19:00" }] },
});

const fieldsOf = (input) => {
  const parsed = profileSchema.safeParse(input);
  assert.equal(parsed.success, false, "expected the profile to be rejected");
  return [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
};

test("profileSchema: accepts a full profile and fills in missing weekdays", () => {
  const parsed = profileSchema.parse({ ...valid(), openingHours: { fri: [{ open: "18:00", close: "02:00" }] } });
  assert.deepEqual(Object.keys(parsed.openingHours), WEEKDAYS);
  assert.deepEqual(parsed.openingHours.fri, [{ open: "18:00", close: "02:00" }]);
  assert.deepEqual(parsed.openingHours.mon, []);
});

test("profileSchema: everything is optional; null address means use the legal one", () => {
  const parsed = profileSchema.parse({});
  assert.equal(parsed.logoUrl, null);
  assert.equal(parsed.address, null);
  assert.deepEqual(parsed.openingHours, noHours());
});

test("profileSchema: an address needs street, a 5-digit zip and city", () => {
  assert.deepEqual(fieldsOf({ ...valid(), address: { street: "", zip: "65474", city: "X" } }), ["address.street"]);
  assert.deepEqual(fieldsOf({ ...valid(), address: { street: "A 1", zip: "6547", city: "X" } }), ["address.zip"]);
  assert.deepEqual(fieldsOf({ ...valid(), address: { street: "A 1", zip: "65474", city: " " } }), ["address.city"]);
});

test("profileSchema: logoUrl must be an https link", () => {
  assert.deepEqual(fieldsOf({ ...valid(), logoUrl: "http://example.com/a.png" }), ["logoUrl"]);
  assert.deepEqual(fieldsOf({ ...valid(), logoUrl: "not a link" }), ["logoUrl"]);
});

test("profileSchema: times are HH:MM and a range cannot be empty", () => {
  for (const range of [
    { open: "7:00", close: "12:00" },
    { open: "24:00", close: "12:00" },
    { open: "10:60", close: "12:00" },
    { open: "10:00", close: "10:00" },
  ]) {
    assert.ok(fieldsOf({ openingHours: { tue: [range] } })[0].startsWith("openingHours.tue"), JSON.stringify(range));
  }
});

test("profileSchema: at most three ranges a day", () => {
  const ranges = ["08:00", "10:00", "12:00", "14:00"].map((open, i) => ({ open, close: `${String(9 + i * 2).padStart(2, "0")}:00` }));
  assert.deepEqual(fieldsOf({ openingHours: { wed: ranges } }), ["openingHours.wed"]);
});

test("profileSchema: overlapping ranges on the same day are rejected", () => {
  const overlapping = [{ open: "11:00", close: "15:00" }, { open: "14:00", close: "22:00" }];
  assert.deepEqual(fieldsOf({ openingHours: { thu: overlapping } }), ["openingHours.thu"]);
  const touching = [{ open: "11:00", close: "15:00" }, { open: "15:00", close: "22:00" }];
  assert.equal(profileSchema.safeParse({ openingHours: { thu: touching } }).success, true);
});

test("profileSchema: a range past midnight may not run into the next day's first range", () => {
  const lateNight = { sat: [{ open: "20:00", close: "03:00" }], sun: [{ open: "02:00", close: "06:00" }] };
  assert.deepEqual(fieldsOf({ openingHours: lateNight }), ["openingHours.sun"]);
  const sundayToMonday = { sun: [{ open: "20:00", close: "03:00" }], mon: [{ open: "02:00", close: "06:00" }] };
  assert.deepEqual(fieldsOf({ openingHours: sundayToMonday }), ["openingHours.mon"]);
  const fine = { sat: [{ open: "20:00", close: "03:00" }], sun: [{ open: "10:00", close: "14:00" }] };
  assert.equal(profileSchema.safeParse({ openingHours: fine }).success, true);
});

const LEGAL_ADDRESS = { street: "Hauptstraße 1", zip: "10115", city: "Berlin", country: "DE" };

test("serializeProfile: no own address uses the legal one", () => {
  const profile = serializeProfile({ legal: { address: LEGAL_ADDRESS } });
  assert.equal(profile.usesLegalAddress, true);
  assert.equal(profile.address, null);
  assert.deepEqual(profile.legalAddress, { street: "Hauptstraße 1", zip: "10115", city: "Berlin" });
  assert.equal(profile.logoUrl, null);
  assert.deepEqual(profile.openingHours, noHours());
});

test("serializePublicProfile: own address wins over the legal one; never leaks legal details", () => {
  const restaurant = {
    name: "Puzzle Kids",
    slug: "puzzle-kids",
    settings: { timezone: "Europe/Berlin" },
    legal: { legalName: "Puzzle GmbH", taxNumber: "1/2/3", address: LEGAL_ADDRESS },
    profile: {
      logoUrl: "https://res.cloudinary.com/demo/image/upload/v1/plate-vista/x/logo/a.png",
      address: { street: "Neben dem Mühlweg 26", zip: "65474", city: "Bischofsheim" },
      openingHours: { mon: [{ open: "11:00", close: "19:00" }] },
    },
  };
  assert.deepEqual(serializePublicProfile(restaurant), {
    name: "Puzzle Kids",
    logoUrl: restaurant.profile.logoUrl,
    address: { street: "Neben dem Mühlweg 26", zip: "65474", city: "Bischofsheim" },
    openingHours: { ...noHours(), mon: [{ open: "11:00", close: "19:00" }] },
    timezone: "Europe/Berlin",
  });
});

test("serializePublicProfile: falls back to the legal address, or null when there is none", () => {
  const withLegal = serializePublicProfile({ name: "R", legal: { address: LEGAL_ADDRESS } });
  assert.deepEqual(withLegal.address, { street: "Hauptstraße 1", zip: "10115", city: "Berlin" });
  assert.equal(withLegal.timezone, "Europe/Berlin");
  assert.equal(serializePublicProfile({ name: "R" }).address, null);
  assert.equal(serializePublicProfile({ name: "R", legal: { address: { country: "DE" } } }).address, null);
});

test("isOwnLogoUrl: only images uploaded to this restaurant's logo folder on our cloud", () => {
  const ok = "https://res.cloudinary.com/demo/image/upload/v1712/plate-vista/abc/logo/x1.webp";
  assert.equal(isOwnLogoUrl(ok, { cloudName: "demo", restaurantId: "abc" }), true);
  assert.equal(isOwnLogoUrl(ok.replace(".webp", ".JPG"), { cloudName: "demo", restaurantId: "abc" }), true);
  assert.equal(isOwnLogoUrl(ok, { cloudName: "demo", restaurantId: "other" }), false);
  assert.equal(isOwnLogoUrl(ok, { cloudName: "evil", restaurantId: "abc" }), false);
  assert.equal(isOwnLogoUrl(ok.replace(".webp", ".svg"), { cloudName: "demo", restaurantId: "abc" }), false);
  assert.equal(isOwnLogoUrl(ok.replace("/logo/", "/menu/"), { cloudName: "demo", restaurantId: "abc" }), false);
  assert.equal(isOwnLogoUrl(undefined, { cloudName: "demo", restaurantId: "abc" }), false);
});

test("signLogoUpload: signs the folder and the allowed formats", () => {
  const env = { ...process.env };
  Object.assign(process.env, {
    CLOUDINARY_CLOUD_NAME: "demo",
    CLOUDINARY_API_KEY: "key",
    CLOUDINARY_API_SECRET: "secret",
  });
  try {
    const signed = signLogoUpload("abc", 1_700_000_000_000);
    assert.equal(signed.folder, logoFolder("abc"));
    assert.equal(signed.folder, "plate-vista/abc/logo");
    assert.equal(signed.allowedFormats, "jpg,png,webp");
    assert.equal(signed.maxBytes, 2 * 1024 * 1024);
    const expected = createHash("sha1")
      .update(`allowed_formats=jpg,png,webp&folder=plate-vista/abc/logo&timestamp=1700000000secret`)
      .digest("hex");
    assert.equal(signed.signature, expected);
  } finally {
    process.env = env;
  }
});

test("publicIdFromUrl: strips the version and the extension", () => {
  assert.equal(
    publicIdFromUrl("https://res.cloudinary.com/demo/image/upload/v1712/plate-vista/abc/logo/x1.webp"),
    "plate-vista/abc/logo/x1"
  );
  assert.equal(
    publicIdFromUrl("https://res.cloudinary.com/demo/image/upload/plate-vista/abc/logo/x1.png"),
    "plate-vista/abc/logo/x1"
  );
  assert.equal(publicIdFromUrl("https://example.com/x.png"), null);
});

test("destroyImage: posts a signed destroy for the image's public id", async () => {
  const env = { ...process.env };
  Object.assign(process.env, { CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "key", CLOUDINARY_API_SECRET: "secret" });
  try {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, body: Object.fromEntries(init.body) });
      return { ok: true, status: 200 };
    };
    const url = "https://res.cloudinary.com/demo/image/upload/v1/plate-vista/abc/logo/x1.png";
    assert.equal(await destroyImage(url, { fetch, now: 1_700_000_000_000 }), true);
    assert.equal(calls[0].url, "https://api.cloudinary.com/v1_1/demo/image/destroy");
    assert.deepEqual(calls[0].body, {
      public_id: "plate-vista/abc/logo/x1",
      timestamp: "1700000000",
      api_key: "key",
      signature: createHash("sha1").update("public_id=plate-vista/abc/logo/x1&timestamp=1700000000secret").digest("hex"),
    });

    assert.equal(await destroyImage("https://example.com/a.png", { fetch }), false);
    assert.equal(calls.length, 1);
    await assert.rejects(destroyImage(url, { fetch: async () => ({ ok: false, status: 401 }) }), /401/);
  } finally {
    process.env = env;
  }
});
