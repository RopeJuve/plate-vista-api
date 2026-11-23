// In-memory stand-in for the part of the Stripe SDK that
// src/modules/payouts/stripe.js uses. Pass it to setStripeClient. Nothing here
// touches the network.
//
//   const fake = createFakeStripe();
//   fake.updateAccount(id, accountState({ cardPayments: "active" }));  // what Stripe would know
//   fake.signedEvent(event, secret);                      // { body, signature }
//   fake.calls;                                           // [["v2.core.accounts.create", params, options], ...]
//   fake.failNext("checkout.sessions.create");            // the next such call throws a Stripe error
//   fake.setDown(true);                                   // every call throws a Stripe error until setDown(false)
//   fake.refundsCreated();                                // refunds Stripe actually made (idempotent replays not counted)
//   fake.completeCheckoutSession(id);                     // the guest paid: expiring it now fails as Stripe does
//   fake.completeCheckoutSession(id, { type: "paypal" }); // ... with these payment_method_details (default: a Visa card)
//   fake.pairingCode({ deviceType: "stripe_s700" });     // a code a real reader shows on screen; returns it
//   fake.setReaderStatus(readerId, "offline");           // what the reader reports to Stripe now
//   fake.readersOn(stripeAccount);                       // readers Stripe has registered on that account
//   fake.locationsOn(stripeAccount);                     // Terminal Locations on that account
//   fake.paymentIntent(id);                              // a PaymentIntent as Stripe keeps it now (for webhook events; latest_charge is an id)
//   fake.charge(id);                                     // a charge as Stripe keeps it now
//   fake.paymentIntentsCreated();                        // PaymentIntents Stripe actually made (replays not counted)
//   fake.readerRequests();                               // reader actions Stripe actually started (replays not counted)
//   fake.captures();                                     // captures Stripe actually made (replays not counted)
//   fake.reader(id);                                     // a reader as Stripe keeps it now, with its action
//   fake.failReaderAction(id, { failureCode, failureMessage }); // the reader's action fails (offline, timeout, ...)
// presentPaymentMethod declines Stripe's declining test card numbers as Stripe does.
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

// Stripe's declining test cards: the last_payment_error each one gives.
const DECLINES = {
  "4000000000000002": { code: "card_declined", declineCode: "generic_decline", message: "Your card was declined." },
  "4000000000009995": { code: "card_declined", declineCode: "insufficient_funds", message: "Your card has insufficient funds." },
  "4000000000009987": { code: "card_declined", declineCode: "lost_card", message: "Your card was declined." },
  "4000000000009979": { code: "card_declined", declineCode: "stolen_card", message: "Your card was declined." },
  "4000000000000069": { code: "expired_card", message: "Your card has expired." },
  "4000000000000119": { code: "processing_error", message: "An error occurred while processing your card. Try again in a little bit." },
};

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
  // Card-present PaymentIntents by id, and what Stripe actually did (an
  // idempotent replay is not counted).
  const intents = new Map();
  let intentsCreated = 0;
  let readerRequests = 0;
  let captures = 0;

  // Runs `make` once per idempotency key on that account; a repeat gets the
  // first response back without running it again.
  const once = (options, make) => {
    const key = options.idempotencyKey && `${options.stripeAccount}|${options.idempotencyKey}`;
    if (key && idempotent.has(key)) return structuredClone(idempotent.get(key));
    const result = make();
    if (key) idempotent.set(key, structuredClone(result));
    return result;
  };

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
  // Stripe sends a PaymentIntent's latest_charge as its id unless it is expanded.
  const unexpanded = (intent, params) => {
    const copy = withoutAccount(structuredClone(intent));
    if (copy.latest_charge && !params?.expand?.includes("latest_charge")) copy.latest_charge = copy.latest_charge.id;
    return copy;
  };

  // While Stripe is down, every call fails.
  let down = false;

  const maybeFail = (op) => {
    if (!down && !failing.delete(op)) return;
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
    setDown(isDown) {
      down = isDown;
    },
    pairingCode({ deviceType = "stripe_s700", serialNumber = `STRM${randomBytes(5).toString("hex").toUpperCase()}` } = {}) {
      const code = `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`;
      pairingCodes.set(code, { deviceType, serialNumber });
      return code;
    },
    // The reader's action in progress fails without a card being declined
    // (it lost its connection, timed out, or someone cancelled on it).
    failReaderAction(id, { failureCode, failureMessage }) {
      Object.assign(readers.get(id).action, { status: "failed", failure_code: failureCode, failure_message: failureMessage });
    },
    // Someone cancelled the PaymentIntent outside Plate Vista.
    cancelPaymentIntent(id) {
      intents.get(id).status = "canceled";
    },
    setReaderStatus(id, status) {
      readers.get(id).status = status;
    },
    paymentIntent: (id) => unexpanded(intents.get(id)),
    charge: (id) => {
      const intent = [...intents.values()].find((found) => found.latest_charge?.id === id);
      return intent ? structuredClone(intent.latest_charge) : undefined;
    },
    paymentIntentsCreated: () => intentsCreated,
    readerRequests: () => readerRequests,
    captures: () => captures,
    reader: (id) => withoutAccount(structuredClone(readers.get(id))),
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
        // The reader asks for a card for the PaymentIntent. A reader busy
        // with another action, or offline, is refused as Stripe does.
        async processPaymentIntent(id, params, options = {}) {
          calls.push(["terminal.readers.processPaymentIntent", id, params, options]);
          maybeFail("terminal.readers.processPaymentIntent");
          return once(options, () => {
            const reader = terminalObject(readers, "terminal.reader", id, options.stripeAccount);
            terminalObject(intents, "payment_intent", params.payment_intent, options.stripeAccount);
            if (reader.status !== "online") {
              throw invalidRequest("Reader is currently offline.", { code: "terminal_reader_offline" });
            }
            if (reader.action?.status === "in_progress") {
              throw invalidRequest("Reader is currently busy processing another request.", { code: "terminal_reader_busy" });
            }
            reader.action = {
              type: "process_payment_intent",
              status: "in_progress",
              process_payment_intent: { payment_intent: params.payment_intent },
            };
            readerRequests += 1;
            return withoutAccount(structuredClone(reader));
          });
        },
        async retrieve(id, params, options = {}) {
          calls.push(["terminal.readers.retrieve", id, params, options]);
          maybeFail("terminal.readers.retrieve");
          return withoutAccount(structuredClone(terminalObject(readers, "terminal.reader", id, options.stripeAccount)));
        },
        // Stops what the reader is doing; Stripe refuses when it is doing nothing.
        async cancelAction(id, params, options = {}) {
          calls.push(["terminal.readers.cancelAction", id, params, options]);
          maybeFail("terminal.readers.cancelAction");
          const reader = terminalObject(readers, "terminal.reader", id, options.stripeAccount);
          if (reader.action?.status !== "in_progress") {
            throw invalidRequest("Reader has no in-progress action to cancel.", { code: "terminal_reader_no_action" });
          }
          Object.assign(reader.action, { status: "failed", failure_code: "canceled" });
          return withoutAccount(structuredClone(reader));
        },
      },
    },
    testHelpers: {
      terminal: {
        readers: {
          // A card tapped on a Simulated Reader: 4242... is approved, so the
          // PaymentIntent is authorized and waits to be captured.
          async presentPaymentMethod(id, params = {}, options = {}) {
            calls.push(["testHelpers.terminal.readers.presentPaymentMethod", id, params, options]);
            maybeFail("testHelpers.terminal.readers.presentPaymentMethod");
            const reader = terminalObject(readers, "terminal.reader", id, options.stripeAccount);
            if (!reader.device_type.startsWith("simulated_")) {
              throw invalidRequest("This endpoint can only be used with simulated readers.");
            }
            if (reader.action?.status !== "in_progress") {
              throw invalidRequest("The reader has no action in progress.");
            }
            const intent = intents.get(reader.action.process_payment_intent.payment_intent);
            const suffix = randomBytes(8).toString("hex");
            const number = String(params.card_present?.number || "4242424242424242");
            const decline = DECLINES[number];
            if (decline) {
              // Stripe declines it: the charge fails, the PaymentIntent waits
              // for another card and the reader's action fails.
              Object.assign(intent, {
                status: "requires_payment_method",
                // Stripe gives the charge as an id unless it is expanded.
                latest_charge: `ch_${suffix}`,
                last_payment_error: {
                  type: "card_error",
                  charge: `ch_${suffix}`,
                  code: decline.code,
                  ...(decline.declineCode ? { decline_code: decline.declineCode } : {}),
                  message: decline.message,
                },
              });
              Object.assign(reader.action, {
                status: "failed",
                failure_code: "card_declined",
                failure_message: decline.message,
              });
              return withoutAccount(structuredClone(reader));
            }
            Object.assign(intent, {
              status: "requires_capture",
              last_payment_error: null,
              amount_capturable: intent.amount,
              latest_charge: {
                id: `ch_${suffix}`,
                object: "charge",
                created: Math.floor(Date.now() / 1000),
                payment_method_details: {
                  type: "card_present",
                  // As Stripe sends it, with fields Plate Vista must not keep.
                  card_present: {
                    brand: "visa",
                    brand_product: "F",
                    cardholder_name: "TEST/CARD",
                    country: "US",
                    emv_auth_data: "8A023030",
                    exp_month: 12,
                    exp_year: 2030,
                    fingerprint: "fp_test_card",
                    funding: "credit",
                    generated_card: "pm_generated_card",
                    last4: String(params.card_present?.number || "4242424242424242").slice(-4),
                    network: "visa",
                    network_transaction_id: "nti_test",
                    read_method: "contactless_emv",
                    receipt: {
                      account_type: "credit",
                      application_cryptogram: "1A2B3C4D5E6F7A8B",
                      application_preferred_name: "VISA CREDIT",
                      authorization_code: "123456",
                      authorization_response_code: "3030",
                      cardholder_verification_method: "none",
                      dedicated_file_name: "A0000000031010",
                      terminal_verification_results: "0000000000",
                      transaction_status_information: "0000",
                    },
                  },
                },
              },
            });
            reader.action.status = "succeeded";
            return withoutAccount(structuredClone(reader));
          },
        },
      },
    },
    paymentIntents: {
      async create(params, options = {}) {
        calls.push(["paymentIntents.create", params, options]);
        maybeFail("paymentIntents.create");
        return once(options, () => {
          const intent = {
            id: `pi_${randomBytes(12).toString("hex")}`,
            object: "payment_intent",
            amount: params.amount,
            amount_capturable: 0,
            amount_received: 0,
            currency: params.currency,
            capture_method: params.capture_method,
            payment_method_types: params.payment_method_types,
            application_fee_amount: params.application_fee_amount ?? null,
            metadata: { ...params.metadata },
            status: "requires_payment_method",
            latest_charge: null,
          };
          intents.set(intent.id, { ...intent, stripeAccount: options.stripeAccount });
          intentsCreated += 1;
          return structuredClone(intent);
        });
      },
      async retrieve(id, params, options = {}) {
        calls.push(["paymentIntents.retrieve", id, params, options]);
        maybeFail("paymentIntents.retrieve");
        return unexpanded(terminalObject(intents, "payment_intent", id, options.stripeAccount), params);
      },
      // Stripe captures only an authorized PaymentIntent.
      async capture(id, params, options = {}) {
        calls.push(["paymentIntents.capture", id, params, options]);
        maybeFail("paymentIntents.capture");
        return once(options, () => {
          const intent = terminalObject(intents, "payment_intent", id, options.stripeAccount);
          if (intent.status !== "requires_capture") {
            throw invalidRequest(
              `This PaymentIntent could not be captured because it has a status of ${intent.status}.`,
              { code: "payment_intent_unexpected_state" }
            );
          }
          Object.assign(intent, { status: "succeeded", amount_received: intent.amount, amount_capturable: 0 });
          captures += 1;
          return withoutAccount(structuredClone(intent));
        });
      },
      // Releases the authorization, or stops the PaymentIntent before a card
      // is read; a reader still asking for its card stops too. Stripe refuses
      // once it is captured or already cancelled.
      async cancel(id, params, options = {}) {
        calls.push(["paymentIntents.cancel", id, params, options]);
        maybeFail("paymentIntents.cancel");
        const intent = terminalObject(intents, "payment_intent", id, options.stripeAccount);
        if (["succeeded", "canceled"].includes(intent.status)) {
          throw invalidRequest(
            `You cannot cancel this PaymentIntent because it has a status of ${intent.status}.`,
            { code: "payment_intent_unexpected_state" }
          );
        }
        Object.assign(intent, { status: "canceled", amount_capturable: 0 });
        for (const reader of readers.values()) {
          if (reader.action?.status === "in_progress" && reader.action.process_payment_intent?.payment_intent === id) {
            Object.assign(reader.action, { status: "failed", failure_code: "canceled" });
          }
        }
        return withoutAccount(structuredClone(intent));
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
