// In-memory stand-in for the part of the Stripe SDK that
// src/modules/payouts/stripe.js uses. Pass it to setStripeClient. Nothing here
// touches the network.
//
//   const fake = createFakeStripe();
//   fake.updateAccount(id, accountState({ cardPayments: "active" }));  // what Stripe would know
//   fake.signedEvent(event, secret);                      // { body, signature }
//   fake.calls;                                           // [["v2.core.accounts.create", params, options], ...]
//   fake.failNext("checkout.sessions.create");            // the next such call throws a Stripe error
//   fake.refundsCreated();                                // refunds Stripe actually made (idempotent replays not counted)
//   fake.completeCheckoutSession(id);                     // the guest paid: expiring it now fails as Stripe does
//   fake.completeCheckoutSession(id, { type: "paypal" }); // ... with these payment_method_details (default: a Visa card)
//   fake.pairingCode({ deviceType: "stripe_s700" });     // a code a real reader shows on screen; returns it
//   fake.setReaderStatus(readerId, "offline");           // what the reader reports to Stripe now
//   fake.readersOn(stripeAccount);                       // readers Stripe has registered on that account
//   fake.locationsOn(stripeAccount);                     // Terminal Locations on that account
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

// A charge's payment_method_details for a card payment, as Stripe sends them.
export const cardDetails = ({ brand = "visa", last4 = "4242", funding = "credit", wallet = null, authorizationCode = "123456" } = {}) => ({
  type: "card",
  card: {
    brand,
    last4,
    funding,
    country: "DE",
    network: brand,
    wallet: wallet ? { type: wallet } : null,
    ...(authorizationCode ? { authorization_code: authorizationCode } : {}),
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
  const failing = new Set();
  // Stripe replays the first response for a repeated idempotency key.
  const idempotent = new Map();
  const refunds = [];
  // Checkout Sessions by id, as Stripe keeps them.
  const checkouts = new Map();
  // Stripe Terminal: Locations and readers by id, each kept with the account
  // it lives on, and the pairing codes readers show that are not used yet.
  const locations = new Map();
  const readers = new Map();
  const pairingCodes = new Map();

  const invalidRequest = (message, { param, code, statusCode = 400 } = {}) => {
    const error = new Error(message);
    error.type = "StripeInvalidRequestError";
    error.statusCode = statusCode;
    if (param) error.param = param;
    if (code) error.code = code;
    return error;
  };

  const terminalObject = (map, kind, id, stripeAccount) => {
    const found = map.get(id);
    if (!found || found.stripeAccount !== stripeAccount) {
      throw invalidRequest(`No such ${kind}: '${id}'`, { code: "resource_missing", statusCode: 404 });
    }
    return found;
  };
  const withoutAccount = ({ stripeAccount, ...object }) => ({ ...object });

  const maybeFail = (op) => {
    if (!failing.delete(op)) return;
    const error = new Error("Something went wrong on Stripe's end");
    error.type = "StripeAPIError";
    error.statusCode = 500;
    throw error;
  };

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

  // A Checkout Session made on a connected account is found only there.
  const checkoutSession = (id, stripeAccount) => {
    const found = checkouts.get(id);
    if (!found || found.stripeAccount !== stripeAccount) {
      const error = new Error(`No such checkout.session: '${id}'`);
      error.type = "StripeInvalidRequestError";
      error.statusCode = 404;
      throw error;
    }
    return found;
  };

  return {
    calls,
    accountsCreated: () => calls.filter(([op]) => op === "v2.core.accounts.create").length,
    checkoutSessionsCreated: () => calls.filter(([op]) => op === "checkout.sessions.create").length,
    refundsCreated: () => refunds.length,
    completeCheckoutSession(id, paymentMethodDetails = cardDetails()) {
      const suffix = randomBytes(8).toString("hex");
      Object.assign(checkouts.get(id), {
        status: "complete",
        payment_status: "paid",
        payment_intent: {
          id: `pi_${suffix}`,
          object: "payment_intent",
          latest_charge: {
            id: `ch_${suffix}`,
            object: "charge",
            created: 1794000000,
            payment_method_details: paymentMethodDetails,
          },
        },
      });
    },
    failNext(op) {
      failing.add(op);
    },
    pairingCode({ deviceType = "stripe_s700", serialNumber = `STRM${randomBytes(5).toString("hex").toUpperCase()}` } = {}) {
      const code = `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`;
      pairingCodes.set(code, { deviceType, serialNumber });
      return code;
    },
    setReaderStatus(id, status) {
      readers.get(id).status = status;
    },
    readersOn: (stripeAccount) =>
      [...readers.values()].filter((reader) => reader.stripeAccount === stripeAccount).map(withoutAccount),
    locationsOn: (stripeAccount) =>
      [...locations.values()].filter((location) => location.stripeAccount === stripeAccount).map(withoutAccount),
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
    checkout: {
      sessions: {
        async create(params, options = {}) {
          calls.push(["checkout.sessions.create", params, options]);
          maybeFail("checkout.sessions.create");
          const key = options.idempotencyKey && `${options.stripeAccount}|${options.idempotencyKey}`;
          if (key && idempotent.has(key)) return { ...idempotent.get(key) };
          const id = `cs_test_${randomBytes(12).toString("hex")}`;
          const amountTotal = params.line_items.reduce(
            (sum, line) => sum + line.price_data.unit_amount * line.quantity,
            0
          );
          const session = {
            id,
            object: "checkout.session",
            mode: params.mode,
            amount_total: amountTotal,
            currency: params.line_items[0]?.price_data.currency,
            expires_at: params.expires_at,
            metadata: params.metadata,
            status: "open",
            url: `https://checkout.stripe.test/c/pay/${id}`,
          };
          checkouts.set(id, { ...session, stripeAccount: options.stripeAccount });
          if (key) idempotent.set(key, session);
          return { ...session };
        },
        async retrieve(id, params, options = {}) {
          calls.push(["checkout.sessions.retrieve", id, params, options]);
          maybeFail("checkout.sessions.retrieve");
          const { stripeAccount, ...session } = checkoutSession(id, options.stripeAccount);
          // Stripe returns the PaymentIntent's id unless it is expanded.
          const expanded = params?.expand?.includes("payment_intent.latest_charge");
          if (session.payment_intent && !expanded) {
            return { ...session, payment_intent: session.payment_intent.id };
          }
          return structuredClone(session);
        },
        // Stripe expires only an open Checkout Session.
        async expire(id, params, options = {}) {
          calls.push(["checkout.sessions.expire", id, params, options]);
          maybeFail("checkout.sessions.expire");
          const session = checkoutSession(id, options.stripeAccount);
          if (session.status !== "open") {
            const error = new Error(
              `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "${session.status}".`
            );
            error.type = "StripeInvalidRequestError";
            error.statusCode = 400;
            throw error;
          }
          Object.assign(session, { status: "expired", url: null });
          const { stripeAccount, ...expired } = session;
          return expired;
        },
      },
    },
    terminal: {
      locations: {
        async create(params, options = {}) {
          calls.push(["terminal.locations.create", params, options]);
          maybeFail("terminal.locations.create");
          const key = options.idempotencyKey && `${options.stripeAccount}|${options.idempotencyKey}`;
          if (key && idempotent.has(key)) return { ...idempotent.get(key) };
          const location = {
            id: `tml_${randomBytes(8).toString("hex")}`,
            object: "terminal.location",
            display_name: params.display_name,
            address: { ...params.address },
          };
          locations.set(location.id, { ...location, stripeAccount: options.stripeAccount });
          if (key) idempotent.set(key, location);
          return { ...location };
        },
      },
      readers: {
        // Simulated readers ("simulated-wpe") exist only on test keys, which
        // this fake stands for. Real ones need a pairing code the reader
        // showed, used once.
        async create(params, options = {}) {
          calls.push(["terminal.readers.create", params, options]);
          maybeFail("terminal.readers.create");
          terminalObject(locations, "terminal.location", params.location, options.stripeAccount);
          let device;
          if (params.registration_code === "simulated-wpe") {
            device = { deviceType: "simulated_wisepos_e", serialNumber: `SIMULATED-${randomBytes(3).toString("hex")}`, status: "online" };
          } else {
            const paired = pairingCodes.get(params.registration_code);
            if (!paired) {
              throw invalidRequest(
                `The registration code "${params.registration_code}" is invalid or has expired.`,
                { param: "registration_code" }
              );
            }
            if (paired.used) {
              throw invalidRequest("This reader is already registered.", { param: "registration_code" });
            }
            paired.used = true;
            device = { ...paired, status: "online" };
          }
          const reader = {
            id: `tmr_${randomBytes(8).toString("hex")}`,
            object: "terminal.reader",
            label: params.label,
            device_type: device.deviceType,
            serial_number: device.serialNumber,
            status: device.status,
            location: params.location,
            action: null,
          };
          readers.set(reader.id, { ...reader, stripeAccount: options.stripeAccount });
          return { ...reader };
        },
        async list(params = {}, options = {}) {
          calls.push(["terminal.readers.list", params, options]);
          maybeFail("terminal.readers.list");
          const data = [...readers.values()]
            .filter((reader) => reader.stripeAccount === options.stripeAccount)
            .filter((reader) => !params.location || reader.location === params.location)
            .map(withoutAccount);
          return { object: "list", data, has_more: false };
        },
        async del(id, params, options = {}) {
          calls.push(["terminal.readers.del", id, params, options]);
          maybeFail("terminal.readers.del");
          terminalObject(readers, "terminal.reader", id, options.stripeAccount);
          readers.delete(id);
          return { id, object: "terminal.reader", deleted: true };
        },
      },
    },
    refunds: {
      async create(params, options = {}) {
        calls.push(["refunds.create", params, options]);
        maybeFail("refunds.create");
        const key = options.idempotencyKey && `${options.stripeAccount}|${options.idempotencyKey}`;
        if (key && idempotent.has(key)) return { ...idempotent.get(key) };
        const refund = {
          id: `re_${randomBytes(12).toString("hex")}`,
          object: "refund",
          payment_intent: params.payment_intent,
          status: "succeeded",
        };
        refunds.push(refund);
        if (key) idempotent.set(key, refund);
        return { ...refund };
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
