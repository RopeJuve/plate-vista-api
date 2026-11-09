import test from "node:test";
import assert from "node:assert/strict";
import {
  VAT_PERCENT,
  mergeReceiptLines,
  splitGross,
  totalsByVat,
  vatFromGross,
} from "../../src/modules/payments/money.js";

test("VAT percentages: NORMAL is 19, REDUCED_1 is 7", () => {
  assert.deepEqual(VAT_PERCENT, { NORMAL: 19, REDUCED_1: 7 });
});

test("vatFromGross rounds gross * rate / (100 + rate) to whole cents", () => {
  assert.equal(vatFromGross(1190, 19), 190);
  assert.equal(vatFromGross(1070, 7), 70);
  assert.equal(vatFromGross(1000, 19), 160); // 159.66
  assert.equal(vatFromGross(1000, 7), 65); // 65.42
  assert.equal(vatFromGross(1, 19), 0);
  assert.equal(vatFromGross(0, 7), 0);
  assert.equal(vatFromGross(250, 7), 16); // 16.355
});

test("vatFromGross rejects anything but whole non-negative cents and a known rate", () => {
  assert.throws(() => vatFromGross(10.5, 19), RangeError);
  assert.throws(() => vatFromGross(-1, 19), RangeError);
  assert.throws(() => vatFromGross(100, -1), RangeError);
  assert.throws(() => vatFromGross(100, Number.NaN), RangeError);
});

test("splitGross: net + vat equals gross for every amount up to 100 EUR", () => {
  for (const rate of [7, 19]) {
    for (let gross = 0; gross <= 10000; gross += 1) {
      const { netCents, vatCents, grossCents } = splitGross(gross, rate);
      assert.equal(grossCents, gross);
      assert.equal(netCents + vatCents, gross);
      assert.ok(Number.isInteger(netCents) && Number.isInteger(vatCents));
      assert.ok(netCents >= 0 && vatCents >= 0);
    }
  }
});

test("totalsByVat sums gross per rate, NORMAL before REDUCED_1, only rates present", () => {
  const lines = [
    { vatRate: "REDUCED_1", lineTotalCents: 1000 },
    { vatRate: "NORMAL", lineTotalCents: 450 },
    { vatRate: "REDUCED_1", lineTotalCents: 1250 },
  ];
  assert.deepEqual(totalsByVat(lines), [
    { vatRate: "NORMAL", netCents: 378, vatCents: 72, grossCents: 450 },
    { vatRate: "REDUCED_1", netCents: 2103, vatCents: 147, grossCents: 2250 },
  ]);
  assert.deepEqual(totalsByVat([{ vatRate: "NORMAL", lineTotalCents: 119 }]), [
    { vatRate: "NORMAL", netCents: 100, vatCents: 19, grossCents: 119 },
  ]);
  assert.deepEqual(totalsByVat([]), []);
});

test("totalsByVat: gross sums equal the lines' total", () => {
  const lines = [
    { vatRate: "NORMAL", lineTotalCents: 333 },
    { vatRate: "REDUCED_1", lineTotalCents: 777 },
    { vatRate: "NORMAL", lineTotalCents: 1 },
  ];
  const totals = totalsByVat(lines);
  assert.equal(
    totals.reduce((sum, row) => sum + row.grossCents, 0),
    lines.reduce((sum, line) => sum + line.lineTotalCents, 0)
  );
});

test("totalsByVat rejects an unknown rate", () => {
  assert.throws(() => totalsByVat([{ vatRate: "ZERO", lineTotalCents: 100 }]), RangeError);
});

test("mergeReceiptLines merges by product and unit price in first-ordered order", () => {
  const lines = [
    { productId: "a", title: "Pizza", unitPriceCents: 1000, quantity: 1, lineTotalCents: 1000, vatRate: "REDUCED_1" },
    { productId: "b", title: "Beer", unitPriceCents: 450, quantity: 2, lineTotalCents: 900, vatRate: "NORMAL" },
    { productId: "a", title: "Pizza", unitPriceCents: 1000, quantity: 2, lineTotalCents: 2000, vatRate: "REDUCED_1" },
    { productId: "a", title: "Pizza", unitPriceCents: 1100, quantity: 1, lineTotalCents: 1100, vatRate: "REDUCED_1" },
  ];
  assert.deepEqual(mergeReceiptLines(lines), [
    { title: "Pizza", quantity: 3, unitPriceCents: 1000, lineTotalCents: 3000, vatRate: "REDUCED_1" },
    { title: "Beer", quantity: 2, unitPriceCents: 450, lineTotalCents: 900, vatRate: "NORMAL" },
    { title: "Pizza", quantity: 1, unitPriceCents: 1100, lineTotalCents: 1100, vatRate: "REDUCED_1" },
  ]);
});

test("mergeReceiptLines keeps the same item at a different VAT rate on its own line", () => {
  const lines = [
    { productId: "a", title: "Pizza", unitPriceCents: 1000, quantity: 1, lineTotalCents: 1000, vatRate: "REDUCED_1" },
    { productId: "a", title: "Pizza", unitPriceCents: 1000, quantity: 1, lineTotalCents: 1000, vatRate: "NORMAL" },
  ];
  assert.equal(mergeReceiptLines(lines).length, 2);
});

test("mergeReceiptLines does not mutate its input and drops extra fields", () => {
  const line = { productId: "a", title: "T", unitPriceCents: 5, quantity: 1, lineTotalCents: 5, vatRate: "NORMAL", notes: "x", station: "bar" };
  const input = [line, { ...line }];
  const merged = mergeReceiptLines(input);
  assert.equal(line.quantity, 1);
  assert.deepEqual(Object.keys(merged[0]).sort(), ["lineTotalCents", "quantity", "title", "unitPriceCents", "vatRate"]);
  assert.equal(merged[0].quantity, 2);
});
