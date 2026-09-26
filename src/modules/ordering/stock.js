import MenuItem from "../menu/menuItem.model.js";

export const stock = {
  afterSave: null,
  adjust: async (changes, restaurantId, mongoSession) => {
    if (restaurantId == null) {
      throw new Error("Query missing restaurantId");
    }
    const ops = changes
      .filter((change) => change.delta !== 0)
      .map((change) => ({
        updateOne: {
          filter: { _id: change.productId, restaurantId },
          update: { $inc: { numSold: change.delta } },
        },
      }));
    if (ops.length === 0) return;
    await MenuItem.bulkWrite(ops, { session: mongoSession });
  },
};
