// Pure money helpers for the Receipt. Money is integer cents throughout.

import { VAT_PERCENT } from "../categories/vatRates.js";

export { VAT_PERCENT };

const assertCents = (value, name) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be whole non-negative cents, got ${value}`);
  }
};

// Cents as a decimal string with two places, e.g. 1250 → "12.50" (fiskaly).
export const centsToDecimal = (cents) => {
  assertCents(cents, "cents");
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
};

const percentOf = (vatRate) => {
  const percent = VAT_PERCENT[vatRate];
  if (percent === undefined) throw new RangeError(`Unknown VAT rate ${vatRate}`);
  return percent;
};

// The VAT inside a gross amount: round(gross * rate / (100 + rate)).
export const vatFromGross = (grossCents, ratePercent) => {
  assertCents(grossCents, "grossCents");
  if (!Number.isFinite(ratePercent) || ratePercent < 0) {
    throw new RangeError(`ratePercent must be a non-negative number, got ${ratePercent}`);
  }
  return Math.round((grossCents * ratePercent) / (100 + ratePercent));
};

// Net is what is left after the VAT, so net + VAT is always the gross.
export const splitGross = (grossCents, ratePercent) => {
  const vatCents = vatFromGross(grossCents, ratePercent);
  return { netCents: grossCents - vatCents, vatCents, grossCents };
};

// Gross per VAT rate from the lines, with net and VAT for each; rates in
// VAT_PERCENT order, only those on the lines.
export const totalsByVat = (lines) => {
  const gross = new Map();
  for (const line of lines) {
    percentOf(line.vatRate);
    assertCents(line.lineTotalCents, "lineTotalCents");
    gross.set(line.vatRate, (gross.get(line.vatRate) || 0) + line.lineTotalCents);
  }
  return Object.keys(VAT_PERCENT)
    .filter((vatRate) => gross.has(vatRate))
    .map((vatRate) => ({ vatRate, ...splitGross(gross.get(vatRate), percentOf(vatRate)) }));
};

// One line per menu item and unit price (and VAT rate, so a merged line is
// never taxed at the wrong rate), in the order each was first ordered.
export const mergeReceiptLines = (lines) => {
  const merged = new Map();
  for (const line of lines) {
    const key = `${line.productId}|${line.unitPriceCents}|${line.vatRate}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += line.quantity;
      existing.lineTotalCents += line.lineTotalCents;
      continue;
    }
    merged.set(key, {
      title: line.title,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: line.lineTotalCents,
      vatRate: line.vatRate,
    });
  }
  return [...merged.values()];
};
