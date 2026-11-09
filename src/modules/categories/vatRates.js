// The one list of VAT rates (docs/adr/0004-vat-rate-belongs-to-category.md).
// Add a rate here and the category/order schemas, validation and receipt
// totals all pick it up. Kept free of mongoose so pure modules can import it.
export const VAT_PERCENT = Object.freeze({ NORMAL: 19, REDUCED_1: 7 });
export const VAT_RATES = Object.freeze(Object.keys(VAT_PERCENT));
export const defaultVatRate = (station) => (station === "bar" ? "NORMAL" : "REDUCED_1");
