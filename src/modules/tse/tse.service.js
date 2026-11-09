import { randomBytes, randomUUID } from "node:crypto";
import Restaurant from "../restaurants/restaurant.model.js";
import { hasCompleteLegalDetails } from "../restaurants/legal.js";
import { AppError } from "../../shared/errors.js";
import { decrypt, encrypt, isValidKey } from "../../shared/crypto.js";
import { logger } from "../../shared/logger.js";
import { createFiskalyClient, FiskalyError } from "./fiskaly.client.js";

// Each restaurant gets one TSS and one client at fiskaly. `tse.setupStep` is
// the last step that finished. The ids we choose are saved before fiskaly
// hears them (the *_PENDING steps), and a resumed setup reads fiskaly's state
// before changing anything, so every step is safe to run again after a save
// that failed.
const STEPS = [
  "TSS_PENDING",
  "TSS_CREATED",
  "UNINITIALIZED",
  "PIN_SET",
  "INITIALIZED",
  "CLIENT_PENDING",
  "CLIENT_CREATED",
  "DONE",
];

let clientOverride = null;
let defaultClient = null;

// Tests swap in a client backed by test/support/fakeFiskaly.js; null restores
// the real one.
export const setFiskalyClient = (client) => {
  clientOverride = client;
};

const fiskaly = () => {
  if (clientOverride) return clientOverride;
  defaultClient ??= createFiskalyClient({
    apiKey: process.env.FISKALY_API_KEY,
    apiSecret: process.env.FISKALY_API_SECRET,
    baseUrl: process.env.FISKALY_BASE_URL || undefined,
  });
  return defaultClient;
};

export const serializeTseStatus = (restaurant) => {
  const tse = restaurant?.tse || {};
  if (tse.setupStep !== "DONE") return { active: false, failedSignatures: 0 };
  return {
    active: true,
    tssSerial: tse.tssSerial,
    clientId: tse.clientId,
    setupAt: tse.setupAt ? new Date(tse.setupAt).toISOString() : null,
    // Filled in by the signing retry work (#29).
    failedSignatures: 0,
  };
};

const notFound = () => new AppError("NOT_FOUND", "Restaurant not found");

export const getTseStatus = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("tse").lean();
  if (!restaurant) throw notFound();
  return serializeTseStatus(restaurant);
};

// fiskaly answered and said no (wrong PIN, not logged in), as opposed to
// being down or unreachable.
const isRejection = (error) => error instanceof FiskalyError && error.status >= 400 && error.status < 500;

const newAdminPin = () => randomBytes(18).toString("base64url");

const runSetup = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId)
    .select("+tse.adminPinEnc +tse.adminPukEnc")
    .lean();
  if (!restaurant) throw notFound();
  const tse = { ...(restaurant.tse || {}) };
  if (tse.setupStep === "DONE") return serializeTseStatus(restaurant);
  if (!hasCompleteLegalDetails(restaurant)) {
    throw new AppError(
      "RESTAURANT_DETAILS_MISSING",
      "Complete the restaurant's legal details before activating the TSE"
    );
  }
  // Checked before fiskaly is called: a PUK we cannot store is lost for good.
  const hasCredentials = Boolean(process.env.FISKALY_API_KEY && process.env.FISKALY_API_SECRET);
  if (!isValidKey(process.env.ENCRYPTION_KEY) || (!clientOverride && !hasCredentials)) {
    throw new AppError("INTERNAL", "TSE activation is not configured", 500);
  }

  const client = fiskaly();
  const save = async (fields) => {
    const $set = {};
    for (const [key, value] of Object.entries(fields)) $set[`tse.${key}`] = value;
    await Restaurant.updateOne({ _id: restaurant._id }, { $set });
    Object.assign(tse, fields);
  };
  const reached = (step) => STEPS.indexOf(tse.setupStep) >= STEPS.indexOf(step);
  const advance = async (step) => {
    if (!reached(step)) await save({ setupStep: step });
  };
  let adminLoggedIn = false;
  const adminAuth = async () => {
    await client.adminAuth(tse.tssId, decrypt(tse.adminPinEnc));
    adminLoggedIn = true;
  };

  let step = "TSS_PENDING";
  try {
    // fiskaly's state of our TSS; null while it has none.
    let state = null;
    if (tse.tssId) {
      const tss = await client.getTss(tse.tssId);
      if (tss && !tse.adminPukEnc) {
        // Created, but the save of its PUK failed: it can never be activated.
        if (tss.state !== "DISABLED") await client.setTssState(tse.tssId, "DISABLED");
        logger.warn({ restaurantId: String(restaurant._id), tssId: tse.tssId }, "TSE setup disabled a TSS whose PUK was lost; starting over");
        await Restaurant.updateOne({ _id: restaurant._id }, { $unset: { tse: 1 } });
        for (const key of Object.keys(tse)) delete tse[key];
      } else if (tss) {
        state = tss.state;
      }
    }

    if (!tse.tssId) await save({ tssId: randomUUID(), setupStep: "TSS_PENDING" });
    if (!state) {
      const tss = await client.createTss(tse.tssId);
      await save({
        tssSerial: tss.serial_number,
        adminPukEnc: encrypt(tss.admin_puk),
        setupStep: "TSS_CREATED",
      });
      state = "CREATED";
    }

    step = "UNINITIALIZED";
    if (state === "CREATED") {
      await client.setTssState(tse.tssId, "UNINITIALIZED");
      state = "UNINITIALIZED";
    }
    await advance("UNINITIALIZED");

    if (state === "UNINITIALIZED") {
      step = "PIN_SET";
      // A saved PIN may already be set at fiskaly: try it before using the PUK.
      if (tse.adminPinEnc) {
        try {
          await adminAuth();
        } catch (error) {
          if (!isRejection(error)) throw error;
        }
      }
      if (!adminLoggedIn) {
        // Kept before fiskaly hears it, so the PIN is never set but unknown.
        if (!tse.adminPinEnc) await save({ adminPinEnc: encrypt(newAdminPin()) });
        await client.changeAdminPin(tse.tssId, {
          adminPuk: decrypt(tse.adminPukEnc),
          newAdminPin: decrypt(tse.adminPinEnc),
        });
      }
      await advance("PIN_SET");

      step = "INITIALIZED";
      if (!adminLoggedIn) await adminAuth();
      await client.setTssState(tse.tssId, "INITIALIZED");
      state = "INITIALIZED";
    }
    if (state !== "INITIALIZED") {
      throw new FiskalyError({ status: 409, code: "UNEXPECTED_TSS_STATE", message: `TSS is ${state}` });
    }
    await advance("PIN_SET");
    await advance("INITIALIZED");

    step = "CLIENT_CREATED";
    if (!reached("CLIENT_CREATED")) {
      const exists = tse.clientId ? Boolean(await client.getClient(tse.tssId, tse.clientId)) : false;
      if (!tse.clientId) {
        await save({ clientId: randomUUID(), clientSerial: `PV-${restaurant._id}`, setupStep: "CLIENT_PENDING" });
      }
      if (!exists) {
        if (!adminLoggedIn) await adminAuth();
        await client.createClient(tse.tssId, tse.clientId, tse.clientSerial || `PV-${restaurant._id}`);
      }
      await save({ setupStep: "CLIENT_CREATED" });
    }

    step = "DONE";
    try {
      await client.adminLogout(tse.tssId);
    } catch (error) {
      // An earlier run logged out already; nothing is left to undo.
      if (!isRejection(error)) throw error;
    }
    await save({ setupAt: new Date(), setupStep: "DONE" });
  } catch (error) {
    if (!(error instanceof FiskalyError)) throw error;
    logger.warn(
      { restaurantId: String(restaurant._id), step, status: error.status, code: error.code, fiskalyRequestId: error.requestId },
      "TSE setup step failed"
    );
    throw new AppError("TSE_SETUP_FAILED", "TSE setup failed; try again to continue where it stopped");
  }
  return serializeTseStatus({ tse });
};

// One setup at a time per restaurant in this process, so a double click does
// not create two TSSes.
const running = new Map();

export const setupTse = (restaurantId) => {
  const key = String(restaurantId);
  if (!running.has(key)) {
    running.set(
      key,
      runSetup(key).finally(() => running.delete(key))
    );
  }
  return running.get(key);
};
