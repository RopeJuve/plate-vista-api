import { reconcileCardReaderPayment } from "./cardReaderCapture.service.js";
import { reconcileOnlinePayment } from "./onlinePayment.service.js";

// The bill is frozen for a payment Stripe may have taken while its webhook
// never arrived: asks Stripe about the online payment or the card reader
// payment it is frozen for, and records it as the webhook would. Returns
// true when it is now recorded. Stripe failures throw.
export const reconcileBillPayment = async (restaurantId, sessionId) =>
  (await reconcileOnlinePayment(restaurantId, sessionId)) || reconcileCardReaderPayment(restaurantId, sessionId);
