// TradeD execution worker: the only component that sends orders to Dhan.
// It runs on a server whose static IP is registered with Dhan. It holds no broker tokens:
// TradeD sends the token with each signed request and the worker never stores or logs it.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { networkInterfaces } from "node:os";

export const MAX_SKEW_MS = 30_000;
export const MAX_BODY_BYTES = 16 * 1024;

const SEGMENTS = new Set(["NSE_EQ", "BSE_EQ", "NSE_FNO", "BSE_FNO"]);
const PRODUCTS = new Set(["CNC", "INTRADAY", "MARGIN"]);
const ORDER_TYPES = new Set(["MARKET", "LIMIT"]);
const SIDES = new Set(["BUY", "SELL"]);
const CORRELATION = /^[A-Za-z0-9_-]{1,30}$/;

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Canonical string both sides sign: timestamp, nonce, method, path and a hash of the body. */
export function signingString(timestamp, nonce, method, path, body) {
  return [timestamp, nonce, method.toUpperCase(), path, sha256Hex(body)].join("\n");
}

export function sign(secret, timestamp, nonce, method, path, body) {
  return createHmac("sha256", secret).update(signingString(timestamp, nonce, method, path, body)).digest("hex");
}

/** Remembers nonces for the skew window so a captured request cannot be replayed. */
export function createNonceStore() {
  const seen = new Map();
  return {
    claim(nonce, now) {
      for (const [key, at] of seen) if (now - at > MAX_SKEW_MS * 2) seen.delete(key);
      if (seen.has(nonce)) return false;
      seen.set(nonce, now);
      return true;
    },
  };
}

export function verifyRequest({ secret, headers, method, path, body, now, nonces }) {
  const timestamp = headers["x-traded-timestamp"];
  const nonce = headers["x-traded-nonce"];
  const signature = headers["x-traded-signature"];
  if (typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") return "missing signature";
  if (!/^\d{13}$/.test(timestamp) || !/^[A-Za-z0-9-]{16,64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return "malformed signature";
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return "stale request";
  const expected = Buffer.from(sign(secret, timestamp, nonce, method, path, body), "hex");
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return "bad signature";
  if (!nonces.claim(nonce, now)) return "replayed request";
  return null;
}

/** Returns an error string, or null when the order is acceptable. Mirrors TradeD's checks as a second line. */
export function validatePlace(input, config) {
  if (!input || typeof input !== "object") return "Missing body.";
  const { credentials, order } = input;
  if (!credentials || typeof credentials.clientId !== "string" || typeof credentials.accessToken !== "string") return "Missing credentials.";
  if (!config.allowedClientIds.has(credentials.clientId)) return "This broker client is not registered on this execution server.";
  if (!credentials.accessToken.includes(".")) return "Access token is malformed.";
  if (!order || typeof order !== "object") return "Missing order.";
  if (typeof order.correlationId !== "string" || !CORRELATION.test(order.correlationId)) return "Invalid correlation id.";
  if (!SIDES.has(order.transactionType)) return "Invalid side.";
  if (!SEGMENTS.has(order.exchangeSegment)) return "Unsupported exchange segment.";
  if (!PRODUCTS.has(order.productType)) return "Unsupported product type.";
  if (!ORDER_TYPES.has(order.orderType)) return "Unsupported order type.";
  if (typeof order.securityId !== "string" || !/^\d{1,12}$/.test(order.securityId)) return "Invalid security id.";
  if (!Number.isInteger(order.quantity) || order.quantity < 1 || order.quantity > config.maxQuantity) return `Quantity must be 1 to ${config.maxQuantity}.`;
  if (typeof order.price !== "number" || !Number.isFinite(order.price) || order.price < 0) return "Invalid price.";
  if (order.orderType === "LIMIT" && order.price <= 0) return "A limit order needs a price.";
  if (order.orderType === "MARKET" && order.price !== 0) return "A market order must not carry a price.";
  if (order.productType === "CNC" && !order.exchangeSegment.endsWith("_EQ")) return "Delivery (CNC) is for equity only.";
  if (order.productType === "MARGIN" && !order.exchangeSegment.endsWith("_FNO")) return "Carry (MARGIN) is for F&O only.";
  return null;
}

export function validateCancel(input, config) {
  if (!input || typeof input !== "object") return "Missing body.";
  const { credentials, orderId } = input;
  if (!credentials || typeof credentials.clientId !== "string" || typeof credentials.accessToken !== "string") return "Missing credentials.";
  if (!config.allowedClientIds.has(credentials.clientId)) return "This broker client is not registered on this execution server.";
  if (typeof orderId !== "string" || !/^\d{1,30}$/.test(orderId)) return "Invalid order id.";
  return null;
}

/**
 * Sends one request to Dhan from the source address mapped to this client, so each holder's orders
 * leave from the static IP registered for that holder. Unmapped clients use the default route.
 */
async function dhan(config, credentials, method, path, body) {
  const headers = {
    Accept: "application/json",
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    "access-token": credentials.accessToken,
    "client-id": credentials.clientId,
  };
  const localAddress = config.routes.get(credentials.clientId);
  return config.transport({ method, url: `${config.dhanApi}${path}`, headers, body: body === undefined ? undefined : JSON.stringify(body), localAddress, timeoutMs: config.timeoutMs });
}

/** Default transport: node:https with an explicit source address. */
export function httpsTransport({ method, url, headers, body, localAddress, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method, headers, localAddress, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let payload = null;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          payload = null;
        }
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, payload });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Transport over fetch, used by tests; records the source address it would have used. */
export function fetchTransport(fetchImpl) {
  return async ({ method, url, headers, body, localAddress, timeoutMs }) => {
    const response = await fetchImpl(url, { method, headers, body, localAddress, signal: AbortSignal.timeout(timeoutMs) });
    const payload = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, payload };
  };
}

function brokerMessage(payload, status) {
  const text = payload && (payload.errorMessage || payload.remarks || payload.omsErrorDescription);
  return typeof text === "string" && text ? text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]").slice(0, 300) : `Dhan returned ${status}.`;
}

/** Looks an order up by its correlation id. Returns the broker order or null if Dhan has no record. */
async function findByCorrelation(config, credentials, correlationId) {
  const result = await dhan(config, credentials, "GET", `/orders/external/${encodeURIComponent(correlationId)}`);
  if (!result.ok) return null;
  const row = Array.isArray(result.payload) ? result.payload[result.payload.length - 1] : result.payload;
  return row && typeof row === "object" && row.orderId ? row : null;
}

/**
 * Places one order. A timeout, dropped connection or 5xx is never retried blindly: the worker first
 * asks Dhan whether an order with this correlation id exists, and reports UNKNOWN if it cannot tell.
 */
export async function placeOrder(input, config) {
  const { credentials, order } = input;
  const body = {
    dhanClientId: credentials.clientId,
    correlationId: order.correlationId,
    transactionType: order.transactionType,
    exchangeSegment: order.exchangeSegment,
    productType: order.productType,
    orderType: order.orderType,
    validity: "DAY",
    securityId: order.securityId,
    quantity: order.quantity,
    price: order.price,
    afterMarketOrder: false,
  };
  let result;
  try {
    result = await dhan(config, credentials, "POST", "/orders", body);
  } catch {
    result = null;
  }
  if (result && result.ok && result.payload && result.payload.orderId) {
    return { outcome: "ACCEPTED", orderId: String(result.payload.orderId), orderStatus: String(result.payload.orderStatus ?? "") };
  }
  if (result && result.status >= 400 && result.status < 500) {
    return { outcome: "REJECTED", message: brokerMessage(result.payload, result.status), brokerCode: result.payload?.errorCode ?? null };
  }
  try {
    const found = await findByCorrelation(config, credentials, order.correlationId);
    if (found) return { outcome: "ACCEPTED", orderId: String(found.orderId), orderStatus: String(found.orderStatus ?? ""), recovered: true };
  } catch {
    // Fall through: the outcome stays unknown.
  }
  return { outcome: "UNKNOWN", message: "Dhan did not confirm the order and has no record of it yet. Check its status before trying again." };
}

export async function cancelOrder(input, config) {
  const { credentials, orderId } = input;
  try {
    const result = await dhan(config, credentials, "DELETE", `/orders/${encodeURIComponent(orderId)}`);
    if (result.ok) return { outcome: "ACCEPTED", orderId, orderStatus: String(result.payload?.orderStatus ?? "") };
    if (result.status >= 400 && result.status < 500) return { outcome: "REJECTED", message: brokerMessage(result.payload, result.status) };
  } catch {
    // Fall through.
  }
  return { outcome: "UNKNOWN", message: "Dhan did not confirm the cancellation. Check the order status." };
}

function localAddresses() {
  return new Set(Object.values(networkInterfaces()).flat().filter(Boolean).map((item) => item.address));
}

/**
 * CLIENT_ROUTES maps each Dhan client to the private IP whose Elastic IP is registered for that holder:
 *   CLIENT_ROUTES=1114171746=172.31.40.31,1100012345=172.31.40.50
 * ALLOWED_CLIENT_IDS (older form) allows clients on the default route.
 */
export function loadConfig(env, fetchImpl, addresses = fetchImpl ? null : localAddresses()) {
  const secret = (env.EXECUTION_SERVICE_SECRET ?? "").trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) throw new Error(`EXECUTION_SERVICE_SECRET must be 32-128 letters, digits, - or _ (found ${secret.length} characters).`);
  const routes = new Map();
  for (const entry of (env.CLIENT_ROUTES ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const match = /^(\d{4,20})=(\d{1,3}(?:\.\d{1,3}){3})$/.exec(entry);
    if (!match) throw new Error(`CLIENT_ROUTES entry "${entry}" must look like 1100012345=172.31.40.50.`);
    if (addresses && !addresses.has(match[2])) throw new Error(`CLIENT_ROUTES: ${match[2]} is not configured on this server. Run add-ips.sh after assigning it in AWS.`);
    if ([...routes.values()].includes(match[2])) throw new Error(`CLIENT_ROUTES: ${match[2]} is mapped to two clients; Dhan needs a unique IP per holder.`);
    routes.set(match[1], match[2]);
  }
  const allowed = new Set([...(env.ALLOWED_CLIENT_IDS ?? "").split(",").map((item) => item.trim()).filter((item) => /^\d{4,20}$/.test(item)), ...routes.keys()]);
  if (allowed.size === 0) throw new Error("Set CLIENT_ROUTES (or ALLOWED_CLIENT_IDS) to at least one Dhan client id.");
  return {
    secret,
    allowedClientIds: allowed,
    routes,
    ordersEnabled: env.ORDERS_ENABLED === "true",
    maxQuantity: Number(env.MAX_ORDER_QUANTITY ?? 1800),
    dhanApi: env.DHAN_API ?? "https://api.dhan.co/v2",
    timeoutMs: 10_000,
    transport: fetchImpl ? fetchTransport(fetchImpl) : httpsTransport,
  };
}

/** Handles one request. Pure apart from the broker calls, so it is tested without a socket. */
export async function handle({ method, path, headers, body }, config, nonces, now = Date.now()) {
  if (method === "GET" && path === "/health") return { status: 200, json: { ok: true, ordersEnabled: config.ordersEnabled, clients: config.allowedClientIds.size } };
  if (method !== "POST" || (path !== "/v1/orders/place" && path !== "/v1/orders/cancel")) return { status: 404, json: { error: "Not found." } };
  const problem = verifyRequest({ secret: config.secret, headers, method, path, body, now, nonces });
  if (problem) return { status: 401, json: { error: "Unauthorized." }, log: problem };
  if (!config.ordersEnabled) return { status: 503, json: { error: "Order placement is switched off on the execution server.", code: "ORDERS_DISABLED" } };
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return { status: 400, json: { error: "Body is not JSON." } };
  }
  if (path === "/v1/orders/place") {
    const invalid = validatePlace(input, config);
    if (invalid) return { status: 400, json: { error: invalid, code: "INVALID_ORDER" } };
    const result = await placeOrder(input, config);
    return { status: 200, json: result, log: `place ${input.order.correlationId} ${result.outcome}` };
  }
  const invalid = validateCancel(input, config);
  if (invalid) return { status: 400, json: { error: invalid, code: "INVALID_CANCEL" } };
  const result = await cancelOrder(input, config);
  return { status: 200, json: result, log: `cancel ${input.orderId} ${result.outcome}` };
}
