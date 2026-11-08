// The only module that talks to fiskaly SIGN DE v2. Pass a `fetch` to swap
// the network out (tests use test/support/fakeFiskaly.js).
//
// Nothing here logs. Errors carry fiskaly's status, code, message and request
// id, never the request body, so a PIN, PUK or API secret cannot leak through
// them.

export const FISKALY_BASE_URL = "https://kassensichv-middleware.fiskaly.com/api/v2";
const REFRESH_BEFORE_MS = 60_000;

export class FiskalyError extends Error {
  constructor({ status, code, message, requestId }) {
    super(message || `fiskaly request failed with ${status}`);
    this.name = "FiskalyError";
    this.status = status;
    this.code = code || null;
    this.requestId = requestId || null;
  }

  toJSON() {
    return { name: this.name, status: this.status, code: this.code, message: this.message, requestId: this.requestId };
  }
}

const readBody = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const id = (value) => encodeURIComponent(String(value));

export const createFiskalyClient = ({
  apiKey,
  apiSecret,
  baseUrl = FISKALY_BASE_URL,
  fetch = globalThis.fetch,
  now = Date.now,
} = {}) => {
  const root = String(baseUrl).replace(/\/+$/, "");
  let token = null;
  let tokenExpiresAt = 0;
  let pendingAuth = null;

  const send = async (method, path, { body, auth }) => {
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (auth) headers.authorization = `Bearer ${auth}`;
    let response;
    try {
      response = await fetch(`${root}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new FiskalyError({ status: 0, code: "NETWORK_ERROR", message: `fiskaly unreachable: ${error?.message || "network error"}` });
    }
    const data = await readBody(response);
    if (response.ok) return { ok: true, data };
    return {
      ok: false,
      error: new FiskalyError({
        status: response.status,
        code: data?.code || data?.error || null,
        message: data?.message,
        requestId: response.headers.get("x-request-id") || data?.request_id || null,
      }),
    };
  };

  const login = async () => {
    if (!apiKey || !apiSecret) {
      throw new FiskalyError({ status: 0, code: "NOT_CONFIGURED", message: "fiskaly credentials are not configured" });
    }
    const result = await send("POST", "/auth", { body: { api_key: apiKey, api_secret: apiSecret } });
    if (!result.ok) throw result.error;
    const { access_token: accessToken, access_token_expires_in: expiresIn, access_token_expires_at: expiresAt } =
      result.data || {};
    if (!accessToken) throw new FiskalyError({ status: 502, code: "BAD_AUTH_RESPONSE", message: "fiskaly returned no token" });
    token = accessToken;
    tokenExpiresAt = expiresIn != null ? now() + Number(expiresIn) * 1000 : Number(expiresAt) * 1000;
    return token;
  };

  const currentToken = async ({ force = false } = {}) => {
    if (!force && token && now() < tokenExpiresAt - REFRESH_BEFORE_MS) return token;
    if (!pendingAuth) {
      token = null;
      pendingAuth = login().finally(() => {
        pendingAuth = null;
      });
    }
    return pendingAuth;
  };

  const request = async (method, path, body) => {
    const first = await send(method, path, { body, auth: await currentToken() });
    if (first.ok) return first.data;
    if (first.error.status !== 401) throw first.error;
    const retry = await send(method, path, { body, auth: await currentToken({ force: true }) });
    if (retry.ok) return retry.data;
    throw retry.error;
  };

  const tx = (tssId, txId, revision, body) =>
    request("PUT", `/tss/${id(tssId)}/tx/${id(txId)}?tx_revision=${Number(revision)}`, body);

  const withSchema = (body, schema) => (schema === undefined ? body : { ...body, schema });

  return {
    createTss: (tssId, metadata) => request("PUT", `/tss/${id(tssId)}`, metadata ? { metadata } : {}),
    setTssState: (tssId, state) => request("PATCH", `/tss/${id(tssId)}`, { state }),
    changeAdminPin: (tssId, { adminPuk, newAdminPin }) =>
      request("PATCH", `/tss/${id(tssId)}/admin`, { admin_puk: adminPuk, new_admin_pin: newAdminPin }),
    adminAuth: (tssId, adminPin) => request("POST", `/tss/${id(tssId)}/admin/auth`, { admin_pin: adminPin }),
    adminLogout: (tssId) => request("POST", `/tss/${id(tssId)}/admin/logout`, {}),
    createClient: (tssId, clientId, serialNumber) =>
      request("PUT", `/tss/${id(tssId)}/client/${id(clientId)}`, { serial_number: serialNumber }),
    startTx: (tssId, txId, { clientId, schema } = {}) =>
      tx(tssId, txId, 1, withSchema({ state: "ACTIVE", client_id: clientId }, schema)),
    finishTx: (tssId, txId, { clientId, schema, revision = 2 } = {}) =>
      tx(tssId, txId, revision, withSchema({ state: "FINISHED", client_id: clientId }, schema)),
    cancelTx: (tssId, txId, { clientId, schema, revision = 2 } = {}) =>
      tx(tssId, txId, revision, withSchema({ state: "CANCELLED", client_id: clientId }, schema)),
  };
};
