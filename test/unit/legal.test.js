import test from "node:test";
import assert from "node:assert/strict";
import { hasCompleteLegalDetails } from "../../src/modules/restaurants/legal.js";

const complete = () => ({
  legal: {
    legalName: "Pizzeria Roma GmbH",
    address: { street: "Hauptstraße 1", zip: "10115", city: "Berlin", country: "DE" },
    taxNumber: "27/123/45678",
    vatId: null,
  },
});

test("hasCompleteLegalDetails: complete with a tax number or a VAT ID", () => {
  assert.equal(hasCompleteLegalDetails(complete()), true);
  const withVatId = complete();
  withVatId.legal.taxNumber = null;
  withVatId.legal.vatId = "DE123456789";
  assert.equal(hasCompleteLegalDetails(withVatId), true);
});

test("hasCompleteLegalDetails: incomplete details", () => {
  assert.equal(hasCompleteLegalDetails(null), false);
  assert.equal(hasCompleteLegalDetails({}), false);
  assert.equal(hasCompleteLegalDetails({ legal: {} }), false);

  const noTaxIds = complete();
  noTaxIds.legal.taxNumber = "";
  assert.equal(hasCompleteLegalDetails(noTaxIds), false);

  for (const field of ["street", "zip", "city"]) {
    const missing = complete();
    missing.legal.address[field] = null;
    assert.equal(hasCompleteLegalDetails(missing), false, field);
  }
  const noName = complete();
  noName.legal.legalName = "  ";
  assert.equal(hasCompleteLegalDetails(noName), false);

  const badZip = complete();
  badZip.legal.address.zip = "1011";
  assert.equal(hasCompleteLegalDetails(badZip), false);
});
