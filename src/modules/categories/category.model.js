import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";

export const STATIONS = ["kitchen", "bar"];
export const CATEGORY_NAME_COLLATION = { locale: "en", strength: 2 };

// A section of one restaurant's menu. Its station decides where every item in
// it is prepared (docs/adr/0001-station-belongs-to-category.md).
const categorySchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    station: { type: String, enum: STATIONS, required: true },
    // Menu order; lower comes first.
    position: { type: Number, required: true },
  },
  { timestamps: true }
);

categorySchema.index(
  { restaurantId: 1, name: 1 },
  { unique: true, collation: CATEGORY_NAME_COLLATION }
);
categorySchema.plugin(tenantPlugin);

const Category = model("Category", categorySchema);
export default Category;
