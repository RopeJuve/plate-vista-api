// Every restaurant starts with these, in this order. Owners rename, reorder,
// or delete what they do not serve. VAT rates are to be confirmed by the
// owner's Steuerberater.
export const DEFAULT_CATEGORIES = [
  { name: "Starters", station: "kitchen", vatRate: "REDUCED_1" },
  { name: "Soups", station: "kitchen", vatRate: "REDUCED_1" },
  { name: "Salads", station: "kitchen", vatRate: "REDUCED_1" },
  { name: "Pizza", station: "kitchen", vatRate: "REDUCED_1" },
  { name: "Pasta", station: "kitchen", vatRate: "REDUCED_1" },
  { name: "Burgers", station: "kitchen", vatRate: "REDUCED_1" },
  { name: "Main Courses", station: "kitchen", vatRate: "REDUCED_1" },
  { name: "Sides", station: "kitchen", vatRate: "REDUCED_1" },
  { name: "Desserts", station: "kitchen", vatRate: "REDUCED_1" },
  { name: "Soft Drinks", station: "bar", vatRate: "NORMAL" },
  { name: "Hot Drinks", station: "bar", vatRate: "NORMAL" },
  { name: "Beer", station: "bar", vatRate: "NORMAL" },
  { name: "Wine", station: "bar", vatRate: "NORMAL" },
  { name: "Cocktails", station: "bar", vatRate: "NORMAL" },
];
