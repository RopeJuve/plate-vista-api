// In-memory, stateful stand-in for fiskaly SIGN DE v2, behind a `fetch`.
// Pass `fake.fetch` to createFiskalyClient. Nothing here touches the network.
//
//   const fake = createFakeFiskaly();
//   fake.failNext("adminAuth", { status: 500 });   // script a failure
//   fake.ops();                                    // ["auth", "createTss", ...]
//   fake.expireTokens();                           // next call gets a 401
//   fake.afterNext("createTss", () => { ... });    // run a hook once the call succeeded
import { randomBytes, randomUUID } from "node:crypto";

const json = (status, body, requestId = randomUUID()) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });

const fail = (status, code, message) =>
  json(status, { status_code: status, error: code, code, message });

const ROUTES = [
  ["POST", /^\/auth$/, "auth"],
  ["PUT", /^\/tss\/([^/]+)$/, "createTss"],
  ["PATCH", /^\/tss\/([^/]+)$/, "setTssState"],
  ["GET", /^\/tss\/([^/]+)$/, "getTss"],
  ["PATCH", /^\/tss\/([^/]+)\/admin$/, "changeAdminPin"],
  ["POST", /^\/tss\/([^/]+)\/admin\/auth$/, "adminAuth"],
  ["POST", /^\/tss\/([^/]+)\/admin\/logout$/, "adminLogout"],
  ["PUT", /^\/tss\/([^/]+)\/client\/([^/]+)$/, "createClient"],
  ["GET", /^\/tss\/([^/]+)\/client\/([^/]+)$/, "getClient"],
  ["PUT", /^\/tss\/([^/]+)\/tx\/([^/]+)$/, "tx"],
  ["GET", /^\/tss\/([^/]+)\/tx\/([^/]+)$/, "getTx"],
];

const TX_OPS = { ACTIVE: "startTx", FINISHED: "finishTx", CANCELLED: "cancelTx" };

export const createFakeFiskaly = ({
  now = () => Date.now(),
  tokenTtlSeconds = 300,
  apiKey,
  apiSecret,
} = {}) => {
  const tsses = new Map();
  const tokens = new Map();
  const calls = [];
  const failures = [];
  const hooks = [];
  let signatureCounter = 0;

  const route = (method, pathname) => {
    const path = pathname.replace(/^.*?\/api\/v2(?=\/)/, "");
    for (const [routeMethod, pattern, op] of ROUTES) {
      const match = routeMethod === method && path.match(pattern);
      if (match) return { op, params: match.slice(1).map(decodeURIComponent), path };
    }
    return { op: null, params: [], path };
  };

  const authorized = (headers) => {
    const value = new Headers(headers).get("authorization") || "";
    const expiresAt = tokens.get(value.replace(/^Bearer /, ""));
    return expiresAt !== undefined && now() < expiresAt;
  };

  const sign = () => {
    signatureCounter += 1;
    return {
      value: randomBytes(48).toString("base64"),
      counter: signatureCounter,
      algorithm: "ecdsa-plain-SHA384",
      public_key: "fake-public-key",
    };
  };

  const handlers = {
    auth(_params, body) {
      if (!body?.api_key || !body?.api_secret) return fail(400, "E_BAD_REQUEST", "api_key and api_secret are required");
      if ((apiKey && body.api_key !== apiKey) || (apiSecret && body.api_secret !== apiSecret)) {
        return fail(401, "E_UNAUTHORIZED", "Invalid credentials");
      }
      const token = `tok_${randomUUID()}`;
      const expiresAt = now() + tokenTtlSeconds * 1000;
      tokens.set(token, expiresAt);
      return json(200, {
        access_token: token,
        access_token_expires_in: tokenTtlSeconds,
        access_token_expires_at: Math.floor(expiresAt / 1000),
      });
    },
    createTss([tssId], body) {
      if (tsses.has(tssId)) return fail(409, "E_TSS_CONFLICT", "TSS already exists");
      const tss = {
        _id: tssId,
        state: "CREATED",
        serial_number: randomBytes(32).toString("hex"),
        admin_puk: randomBytes(5).toString("hex").toUpperCase(),
        admin_pin: null,
        admin_authenticated: false,
        metadata: body?.metadata || {},
        clients: new Map(),
        transactions: new Map(),
        txNumber: 0,
      };
      tsses.set(tssId, tss);
      return json(200, publicTss(tss, { withPuk: true }));
    },
    getTss([tssId]) {
      const tss = tsses.get(tssId);
      return tss ? json(200, publicTss(tss)) : fail(404, "E_TSS_NOT_FOUND", "TSS not found");
    },
    setTssState([tssId], body) {
      const tss = tsses.get(tssId);
      if (!tss) return fail(404, "E_TSS_NOT_FOUND", "TSS not found");
      const allowed =
        (tss.state === "CREATED" && body?.state === "UNINITIALIZED") ||
        (tss.state === "UNINITIALIZED" && body?.state === "INITIALIZED" && tss.admin_authenticated) ||
        (body?.state === "DISABLED" && tss.state !== "DELETED") ||
        tss.state === body?.state;
      if (!allowed) return fail(409, "E_TSS_STATE", `Cannot move TSS from ${tss.state} to ${body?.state}`);
      tss.state = body.state;
      return json(200, publicTss(tss));
    },
    changeAdminPin([tssId], body) {
      const tss = tsses.get(tssId);
      if (!tss) return fail(404, "E_TSS_NOT_FOUND", "TSS not found");
      if (tss.state === "CREATED") return fail(409, "E_TSS_STATE", "TSS is not initialized");
      if (body?.admin_puk !== tss.admin_puk) return fail(401, "E_INVALID_PUK", "Invalid admin PUK");
      if (typeof body?.new_admin_pin !== "string" || body.new_admin_pin.length < 6) {
        return fail(400, "E_BAD_REQUEST", "Admin PIN too short");
      }
      tss.admin_pin = body.new_admin_pin;
      return json(200, undefined);
    },
    adminAuth([tssId], body) {
      const tss = tsses.get(tssId);
      if (!tss) return fail(404, "E_TSS_NOT_FOUND", "TSS not found");
      if (!tss.admin_pin || body?.admin_pin !== tss.admin_pin) return fail(401, "E_INVALID_PIN", "Invalid admin PIN");
      tss.admin_authenticated = true;
      return json(200, {});
    },
    adminLogout([tssId]) {
      const tss = tsses.get(tssId);
      if (!tss) return fail(404, "E_TSS_NOT_FOUND", "TSS not found");
      if (!tss.admin_authenticated) return fail(401, "E_ADMIN_NOT_AUTHENTICATED", "Admin is not authenticated");
      tss.admin_authenticated = false;
      return json(200, {});
    },
    createClient([tssId, clientId], body) {
      const tss = tsses.get(tssId);
      if (!tss) return fail(404, "E_TSS_NOT_FOUND", "TSS not found");
      if (tss.state !== "INITIALIZED") return fail(409, "E_TSS_STATE", "TSS is not initialized");
      if (!tss.admin_authenticated) return fail(401, "E_ADMIN_NOT_AUTHENTICATED", "Admin is not authenticated");
      if (!body?.serial_number) return fail(400, "E_BAD_REQUEST", "serial_number is required");
      const existing = tss.clients.get(clientId);
      if (existing) return json(200, existing);
      const client = { _id: clientId, serial_number: body.serial_number, tss_id: tssId, state: "REGISTERED" };
      tss.clients.set(clientId, client);
      return json(200, client);
    },
    getClient([tssId, clientId]) {
      const client = tsses.get(tssId)?.clients.get(clientId);
      return client ? json(200, client) : fail(404, "E_CLIENT_NOT_FOUND", "Client not found");
    },
    getTx([tssId, txId]) {
      const tx = tsses.get(tssId)?.transactions.get(txId);
      return tx ? json(200, tx) : fail(404, "E_TX_NOT_FOUND", "Transaction not found");
    },
    tx([tssId, txId], body, url) {
      const tss = tsses.get(tssId);
      if (!tss) return fail(404, "E_TSS_NOT_FOUND", "TSS not found");
      if (tss.state !== "INITIALIZED") return fail(409, "E_TSS_STATE", "TSS is not initialized");
      const client = tss.clients.get(body?.client_id);
      if (!client) return fail(404, "E_CLIENT_NOT_FOUND", "Client not found");
      const revision = Number(url.searchParams.get("tx_revision"));
      const existing = tss.transactions.get(txId);
      const timestamp = Math.floor(now() / 1000);
      if (body.state === "ACTIVE" && !existing) {
        if (revision !== 1) return fail(400, "E_TX_REVISION", "First revision must be 1");
        tss.txNumber += 1;
        const tx = {
          _id: txId,
          number: tss.txNumber,
          state: "ACTIVE",
          revision: 1,
          client_id: client._id,
          client_serial_number: client.serial_number,
          tss_id: tssId,
          tss_serial_number: tss.serial_number,
          time_start: timestamp,
          schema: body.schema,
          signature: sign(),
        };
        tss.transactions.set(txId, tx);
        return json(200, tx);
      }
      if (!existing) return fail(404, "E_TX_NOT_FOUND", "Transaction not found");
      if (existing.state !== "ACTIVE") return fail(409, "E_TX_STATE", `Transaction is ${existing.state}`);
      if (revision !== existing.revision + 1) return fail(400, "E_TX_REVISION", "Wrong revision");
      Object.assign(existing, {
        state: body.state,
        revision,
        schema: body.schema ?? existing.schema,
        signature: sign(),
      });
      if (body.state !== "ACTIVE") {
        existing.time_end = timestamp;
        existing.qr_code_data = [
          "V0",
          client.serial_number,
          "Kassenbeleg-V1",
          "",
          existing.number,
          existing.signature.counter,
          existing.time_start,
          existing.time_end,
          existing.signature.algorithm,
          "unixTime",
          existing.signature.value,
          existing.signature.public_key,
        ].join(";");
      }
      return json(200, existing);
    },
  };

  const publicTss = (tss, { withPuk = false } = {}) => ({
    _id: tss._id,
    state: tss.state,
    serial_number: tss.serial_number,
    metadata: tss.metadata,
    ...(withPuk ? { admin_puk: tss.admin_puk } : {}),
  });

  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    let { op, params, path } = route(method, url.pathname);
    if (op === "tx") op = TX_OPS[body?.state] || "tx";
    calls.push({ op, method, path: path + url.search, body });
    if (!op) return fail(404, "E_NOT_FOUND", `No route for ${method} ${path}`);
    const index = failures.findIndex((entry) => entry.op === op);
    if (index !== -1) {
      const [{ status, code, message, throws }] = failures.splice(index, 1);
      if (throws) throw throws;
      return fail(status, code, message);
    }
    if (op !== "auth" && !authorized(init.headers)) return fail(401, "E_UNAUTHORIZED", "Invalid or expired token");
    const handler = handlers[op] || handlers.tx;
    const response = handler(params, body, url);
    const hook = response.ok ? hooks.findIndex((entry) => entry.matches(calls.at(-1))) : -1;
    if (hook !== -1) await hooks.splice(hook, 1)[0].run();
    return response;
  };

  return {
    fetch,
    calls,
    // fiskaly operations called, in order; auth calls included unless excluded.
    ops: ({ withAuth = true } = {}) => calls.map((call) => call.op).filter((op) => withAuth || op !== "auth"),
    clearCalls: () => {
      calls.length = 0;
    },
    // Make the next call to `op` fail. `throws` simulates a network error.
    failNext: (op, { status = 500, code = "E_INTERNAL", message = "Scripted failure", throws } = {}) => {
      failures.push({ op, status, code, message, throws });
    },
    // Run `run` once, right after the next successful call matching `match`
    // (an op name or a predicate on { op, method, path, body }) and before its
    // response goes back. Tests use it to fail the save that follows.
    afterNext: (match, run) => {
      const matches = typeof match === "function" ? match : (call) => call.op === match;
      hooks.push({ matches, run });
    },
    // Revoke every token, so the next authenticated call gets a 401.
    expireTokens: () => tokens.clear(),
    tss: (tssId) => tsses.get(tssId),
    allTss: () => [...tsses.values()],
    get signatureCounter() {
      return signatureCounter;
    },
  };
};
