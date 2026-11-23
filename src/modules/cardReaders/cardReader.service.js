import mongoose from "mongoose";
import Restaurant from "../restaurants/restaurant.model.js";
import { AppError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { parseOrThrow } from "../../shared/validate.js";
import {
  assertTerminalConfigured,
  createTerminalLocation,
  isStripeTestMode,
  listCardReaders as listStripeReaders,
  registerCardReader,
  removeCardReader as removeStripeReader,
} from "../payouts/stripe.js";
import CardReader from "./cardReader.model.js";
import { addCardReaderSchema, addSimulatedReaderSchema } from "./cardReader.schemas.js";

const notFound = (what = "Card reader") => new AppError("NOT_FOUND", `${what} not found`);

const providerError = (error, message) => {
  if (error instanceof AppError) return error;
  logger.warn({ err: error }, message);
  return new AppError("PAYMENT_PROVIDER_ERROR", message);
};

// The contract's CardReader. busyWith stays null until card reader payments exist.
export const serializeCardReader = (reader) => ({
  id: String(reader._id),
  name: reader.name,
  deviceType: reader.deviceType,
  serialNumber: reader.serialNumber ?? null,
  status: reader.status === "online" ? "online" : "offline",
  simulated: Boolean(reader.simulated),
  busyWith: null,
  addedAt: reader.createdAt.toISOString(),
});

const loadRestaurant = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("name legal payoutAccount").lean();
  if (!restaurant) throw notFound("Restaurant");
  return restaurant;
};

const byName = { name: 1, createdAt: 1, _id: 1 };
const NAME_COLLATION = { locale: "de", strength: 2 };

// Every reader with the status Stripe reports now. If Stripe cannot be read,
// the last status it reported is shown.
export const listCardReaders = async (restaurantId) => {
  assertTerminalConfigured();
  const restaurant = await loadRestaurant(restaurantId);
  const account = restaurant.payoutAccount;
  let readers = await CardReader.find({ restaurantId }).sort(byName).collation(NAME_COLLATION).lean();

  if (readers.length > 0 && account?.stripeAccountId && account.terminalLocationId) {
    try {
      const atStripe = new Map(
        (await listStripeReaders({ stripeAccountId: account.stripeAccountId, locationId: account.terminalLocationId }))
          .map((reader) => [reader.stripeReaderId, reader.status])
      );
      readers = readers.map((reader) => ({ ...reader, status: atStripe.get(reader.stripeReaderId) ?? "offline" }));
      await CardReader.bulkWrite(
        readers.map((reader) => ({
          updateOne: { filter: { _id: reader._id, restaurantId }, update: { $set: { status: reader.status } } },
        }))
      );
    } catch (error) {
      logger.warn({ err: error, restaurantId }, "could not read card readers from Stripe; showing the stored status");
    }
  }

  return {
    items: readers.map(serializeCardReader),
    testMode: isStripeTestMode(),
    payoutAccountReady: Boolean(account?.chargesEnabled),
  };
};

const hasLegalAddress = (legal) =>
  Boolean(legal?.legalName && legal.address?.street && legal.address?.zip && legal.address?.city);

// The restaurant's one Terminal Location, made from its legal address with
// the first reader. Only the first save wins; a concurrent request gets the
// same Location from Stripe through the idempotency key anyway.
const ensureTerminalLocation = async (restaurant) => {
  const account = restaurant.payoutAccount;
  if (account.terminalLocationId) return account.terminalLocationId;
  if (!hasLegalAddress(restaurant.legal)) {
    throw new AppError(
      "RESTAURANT_DETAILS_MISSING",
      "Fill in the restaurant's legal name and address before adding a card reader"
    );
  }
  let locationId;
  try {
    locationId = await createTerminalLocation({
      stripeAccountId: account.stripeAccountId,
      restaurantId: restaurant._id,
      displayName: restaurant.legal.legalName,
      address: restaurant.legal.address,
    });
  } catch (error) {
    throw providerError(error, "The payment provider could not set up the card reader location");
  }
  const saved = await Restaurant.findOneAndUpdate(
    {
      _id: restaurant._id,
      "payoutAccount.stripeAccountId": account.stripeAccountId,
      "payoutAccount.terminalLocationId": { $exists: false },
    },
    { $set: { "payoutAccount.terminalLocationId": locationId } },
    { new: true, projection: { payoutAccount: 1 } }
  ).lean();
  if (saved) return saved.payoutAccount.terminalLocationId;
  const current = await Restaurant.findById(restaurant._id).select("payoutAccount").lean();
  return current?.payoutAccount?.terminalLocationId || locationId;
};

const addReader = async (restaurantId, { name, registrationCode, simulated }) => {
  const restaurant = await loadRestaurant(restaurantId);
  const account = restaurant.payoutAccount;
  if (!account?.stripeAccountId || !account.chargesEnabled) {
    throw new AppError("PAYOUT_ACCOUNT_NOT_READY", "The Payout Account cannot take payments yet.");
  }
  const locationId = await ensureTerminalLocation(restaurant);
  let registered;
  try {
    registered = await registerCardReader({
      stripeAccountId: account.stripeAccountId,
      locationId,
      registrationCode,
      label: name,
      simulated,
    });
  } catch (error) {
    throw providerError(error, "The payment provider could not register the card reader");
  }
  const reader = await CardReader.create({
    restaurantId,
    stripeAccountId: account.stripeAccountId,
    ...registered,
    name,
    simulated,
  });
  return serializeCardReader(reader.toObject());
};

export const addCardReader = async (restaurantId, input) => {
  assertTerminalConfigured();
  const { registrationCode, name } = parseOrThrow(addCardReaderSchema, input || {});
  return addReader(restaurantId, { name, registrationCode, simulated: false });
};

export const addSimulatedReader = async (restaurantId, input) => {
  assertTerminalConfigured();
  const { name } = parseOrThrow(addSimulatedReaderSchema, input || {});
  if (!isStripeTestMode()) {
    throw new AppError("SIMULATED_READER_LIVE_MODE", "Simulated readers exist only in test mode.");
  }
  return addReader(restaurantId, { name, simulated: true });
};

// Removes the reader at Stripe first; if Stripe fails, it stays here too.
export const removeCardReader = async (restaurantId, id) => {
  assertTerminalConfigured();
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const reader = await CardReader.findOne({ _id: id, restaurantId }).lean();
  if (!reader) throw notFound();
  try {
    await removeStripeReader({ stripeAccountId: reader.stripeAccountId, stripeReaderId: reader.stripeReaderId });
  } catch (error) {
    throw providerError(error, "The payment provider could not remove the card reader");
  }
  await CardReader.deleteOne({ _id: reader._id, restaurantId });
};
