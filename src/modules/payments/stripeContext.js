import Restaurant from "../restaurants/restaurant.model.js";

// Who records what Stripe tells us (a webhook, or Stripe read back when the
// webhook was lost): the actor on those Payments and their audit.
export const STRIPE_ACTOR = Object.freeze({ type: "system", id: "stripe" });

// The restaurant's Payout Account at Stripe (its connected account id), or
// undefined without one.
export const stripeAccountOf = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount.stripeAccountId").lean();
  return restaurant?.payoutAccount?.stripeAccountId;
};
