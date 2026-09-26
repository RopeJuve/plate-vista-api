const TENANT_OPS = [
  "countDocuments",
  "deleteMany",
  "deleteOne",
  "find",
  "findOne",
  "findOneAndDelete",
  "findOneAndReplace",
  "findOneAndUpdate",
  "replaceOne",
  "updateMany",
  "updateOne",
];

const missingTenant = () => {
  const error = new Error("Query missing restaurantId");
  error.name = "TenantError";
  return error;
};

export const tenantPlugin = (schema) => {
  TENANT_OPS.forEach((op) => {
    schema.pre(op, function tenantGuard() {
      if (this.getOptions?.().skipTenant) return;
      const filter = this.getFilter();
      if (filter?.restaurantId == null) {
        throw missingTenant();
      }
    });
  });

  schema.pre("aggregate", function tenantAggregateGuard() {
    if (this.options?.skipTenant) return;
    const first = this.pipeline()[0];
    if (first?.$match?.restaurantId == null) {
      throw missingTenant();
    }
  });
};
