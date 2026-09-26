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
    employee: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
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

employeeSchema.plugin(tenantPlugin);

const Employee = model("Employee", employeeSchema);
export default Employee;
