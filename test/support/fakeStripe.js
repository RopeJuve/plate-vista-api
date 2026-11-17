// In-memory stand-in for the part of the Stripe SDK that
// src/modules/payouts/stripe.js uses. Pass it to setStripeClient. Nothing here
// touches the network.
//
//   const fake = createFakeStripe();
//   fake.updateAccount(id, accountState({ cardPayments: "active" }));  // what Stripe would know
//   fake.signedEvent(event, secret);                      // { body, signature }
//   fake.calls;                                           // [["v2.core.accounts.create", params, options], ...]
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

// The parts of an Accounts v2 account the Payout Account reads: the card
// payments capability and whether the owner still has requirements to fill in.
export const accountState = ({ cardPayments = "restricted", ownerDue = true } = {}) => ({
  configuration: {
    merchant: { applied: true, capabilities: { card_payments: { status: cardPayments } } },
  },
  requirements: {
    entries: ownerDue
      ? [{
        awaiting_action_from: "user",
        description: "representative.address.line1",
        minimum_deadline: { status: "currently_due" },
      }]
      : [],
  },
});

// Stripe returns configuration and requirements only when they are included.
const withIncluded = (found, include = []) => ({
  ...found,
  configuration: include.some((path) => path.startsWith("configuration.")) ? found.configuration : null,
  requirements: include.includes("requirements") ? found.requirements : null,
});

const verify = (payload, header, secret) => {
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
};

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
    accountsCreated: () => calls.filter(([op]) => op === "v2.core.accounts.create").length,
    updateAccount(id, fields) {
      store.set(id, { ...account(id), ...fields });
    },
    signedEvent(event, secret, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
      const body = JSON.stringify(event);
      return { body, signature: `t=${timestamp},v1=${sign(body, secret, timestamp)}` };
    },

    v2: {
      core: {
        accounts: {
          async create(params, options) {
            calls.push(["v2.core.accounts.create", params, options]);
            const id = `acct_${randomBytes(8).toString("hex")}`;
            store.set(id, {
              id,
              object: "v2.core.account",
              dashboard: params.dashboard,
              metadata: params.metadata,
              ...accountState(),
            });
            return withIncluded(account(id), params.include);
          },
          async retrieve(id, params = {}) {
            calls.push(["v2.core.accounts.retrieve", id, params]);
            return withIncluded(account(id), params.include);
          },
        },
        accountLinks: {
          async create(params) {
            calls.push(["v2.core.accountLinks.create", params]);
            account(params.account);
            return {
              object: "v2.core.account_link",
              account: params.account,
              url: `https://connect.stripe.test/setup/e/${params.account}/${randomBytes(6).toString("hex")}`,
            };
          },
        },
      },
    },
    // Thin event notifications, as the SDK parses them.
    parseEventNotification(payload, header, secret) {
      const parsed = verify(payload, header, secret);
      if (parsed.object === "event") {
        throw new Error("You passed a v1 Event to a method that expects a thin event notification.");
      }
      return parsed;
    },
    webhooks: {
      constructEvent(payload, header, secret) {
        return verify(payload, header, secret);
      },
    },
  };
};
