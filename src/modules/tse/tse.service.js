import { randomBytes, randomUUID } from "node:crypto";
import Restaurant from "../restaurants/restaurant.model.js";
import { hasCompleteLegalDetails } from "../restaurants/legal.js";
import { AppError } from "../../shared/errors.js";
import { decrypt, encrypt, isValidKey } from "../../shared/crypto.js";
import { logger } from "../../shared/logger.js";
import { createFiskalyClient, FiskalyError } from "./fiskaly.client.js";

// Each restaurant gets one TSS and one client at fiskaly. Setup runs these
// steps in order and saves `tse.setupStep` after each, so a call after a
// failure picks up where the last one stopped.
const STEPS = ["TSS_CREATED", "UNINITIALIZED", "PIN_SET", "INITIALIZED", "CLIENT_CREATED", "DONE"];

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
    Object.assign(tse, fields);
    const $set = {};
    for (const [key, value] of Object.entries(fields)) $set[`tse.${key}`] = value;
    await Restaurant.updateOne({ _id: restaurant._id }, { $set });
  };
  let adminLoggedIn = false;
  const adminAuth = async () => {
    await client.adminAuth(tse.tssId, decrypt(tse.adminPinEnc));
    adminLoggedIn = true;
  };

  const run = {
    TSS_CREATED: async () => {
      const tssId = randomUUID();
      const tss = await client.createTss(tssId);
      await save({
        tssId,
        tssSerial: tss.serial_number,
        adminPukEnc: encrypt(tss.admin_puk),
        setupStep: "TSS_CREATED",
      });
    },
    UNINITIALIZED: async () => {
      await client.setTssState(tse.tssId, "UNINITIALIZED");
      await save({ setupStep: "UNINITIALIZED" });
    },
    PIN_SET: async () => {
      // Kept before fiskaly hears it, so the PIN is never set but unknown.
      if (!tse.adminPinEnc) await save({ adminPinEnc: encrypt(newAdminPin()) });
      await client.changeAdminPin(tse.tssId, {
        adminPuk: decrypt(tse.adminPukEnc),
        newAdminPin: decrypt(tse.adminPinEnc),
      });
      await save({ setupStep: "PIN_SET" });
    },
    INITIALIZED: async () => {
      await adminAuth();
      await client.setTssState(tse.tssId, "INITIALIZED");
      await save({ setupStep: "INITIALIZED" });
    },
    CLIENT_CREATED: async () => {
      if (!adminLoggedIn) await adminAuth();
      const clientId = randomUUID();
      const clientSerial = `PV-${restaurant._id}`;
      await client.createClient(tse.tssId, clientId, clientSerial);
      await save({ clientId, clientSerial, setupStep: "CLIENT_CREATED" });
    },
    DONE: async () => {
      await client.adminLogout(tse.tssId);
      await save({ setupAt: new Date(), setupStep: "DONE" });
    },
  };

  for (const step of STEPS.slice(STEPS.indexOf(tse.setupStep) + 1)) {
    try {
      await run[step]();
    } catch (error) {
      if (!(error instanceof FiskalyError)) throw error;
      logger.warn(
        { restaurantId: String(restaurant._id), step, status: error.status, code: error.code, fiskalyRequestId: error.requestId },
        "TSE setup step failed"
      );
      throw new AppError("TSE_SETUP_FAILED", "TSE setup failed; try again to continue where it stopped");
    }
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
