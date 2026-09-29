import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";

const employeeSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    employee: { type: String, required: true, trim: true },
    // Contact info for staff. Owners log in with it, so theirs is required.
    email: {
      type: String,
      lowercase: true,
      trim: true,
      required() {
        return this.role === "owner";
      },
    },
    password: { type: String, required: true, select: false },
    position: { type: String, required: true },
    role: {
      type: String,
      enum: ["owner", "admin", "waiter", "kitchen", "staff"],
      default: "staff",
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Staff log in with restaurant slug + name, so a name is unique only inside
// its restaurant, and "Rope" and "rope" count as the same name.
export const NAME_COLLATION = { locale: "en", strength: 2 };
employeeSchema.index(
  { restaurantId: 1, employee: 1 },
  { unique: true, collation: NAME_COLLATION }
);
// Owners log in with email alone, so it must point at exactly one owner.
employeeSchema.index(
  { email: 1 },
  // Named so it never collides with the old global "email_1" index.
  { unique: true, partialFilterExpression: { role: "owner" }, name: "owner_email_1" }
);

employeeSchema.plugin(tenantPlugin);

const Employee = model("Employee", employeeSchema);
export default Employee;
