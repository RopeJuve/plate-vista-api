// In-memory stand-in for the part of the Stripe SDK that
// src/modules/payouts/stripe.js uses. Pass it to setStripeClient. Nothing here
// touches the network.
//
//   const fake = createFakeStripe();
//   fake.updateAccount(id, { charges_enabled: true });   // what Stripe would know
//   fake.signedEvent(event, secret);                      // { body, signature }
//   fake.calls;                                           // [["accounts.create", params, options], ...]
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

class StripeSignatureVerificationError extends Error {
  constructor(message) {
    super(message);
    this.type = "StripeSignatureVerificationError";
  }
}

// Stripe's scheme: header "t=<unix>,v1=<hex hmac-sha256 of `${t}.${payload}`>".
const sign = (payload, secret, timestamp) =>
  createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");

export const createFakeStripe = () => {
  const store = new Map();
  const calls = [];

  const account = (id) => {
    const found = store.get(id);
    if (!found) {
      const error = new Error(`No such account: '${id}'`);
      error.type = "StripeInvalidRequestError";
      error.statusCode = 404;
      throw error;
    }
    return { ...found };
  };

  return {
    calls,
    accountsCreated: () => calls.filter(([op]) => op === "accounts.create").length,
    updateAccount(id, fields) {
      store.set(id, { ...account(id), ...fields });
    },
    signedEvent(event, secret, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
      const body = JSON.stringify(event);
      return { body, signature: `t=${timestamp},v1=${sign(body, secret, timestamp)}` };
    },

    accounts: {
      async create(params, options) {
        calls.push(["accounts.create", params, options]);
        const id = `acct_${randomBytes(8).toString("hex")}`;
        store.set(id, {
          id,
          object: "account",
          type: params.type,
          country: params.country,
          charges_enabled: false,
          details_submitted: false,
        });
        return account(id);
      },
      async retrieve(id) {
        calls.push(["accounts.retrieve", id]);
        return account(id);
      },
    },
    accountLinks: {
      async create(params) {
        calls.push(["accountLinks.create", params]);
        account(params.account);
        return {
          object: "account_link",
          url: `https://connect.stripe.test/setup/e/${params.account}/${randomBytes(6).toString("hex")}`,
        };
      },
    },
    webhooks: {
      constructEvent(payload, header, secret) {
        const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload;
        if (typeof text !== "string") {
          throw new StripeSignatureVerificationError("Webhook payload must be provided as a string or a Buffer");
        }
        const parts = Object.fromEntries(
          String(header || "").split(",").map((part) => part.split("=")).filter((pair) => pair.length === 2)
        );
        const expected = Buffer.from(sign(text, secret, parts.t || ""));
        const given = Buffer.from(parts.v1 || "");
        if (!parts.t || given.length !== expected.length || !timingSafeEqual(given, expected)) {
          throw new StripeSignatureVerificationError("No signatures found matching the expected signature for payload");
        }
        return JSON.parse(text);
      },
    },
  };
};
