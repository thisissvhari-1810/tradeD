// Starts the execution worker on 127.0.0.1. Caddy terminates HTTPS in front of it.
import { createServer } from "node:http";
import { createNonceStore, handle, loadConfig, MAX_BODY_BYTES } from "./lib.mjs";

const config = loadConfig(process.env);
const nonces = createNonceStore();
const port = Number(process.env.PORT ?? 8787);

function log(event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

const server = createServer((request, response) => {
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      response.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Body too large." }));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", async () => {
    if (response.writableEnded) return;
    const path = new URL(request.url ?? "/", "http://worker").pathname;
    try {
      const result = await handle({ method: request.method ?? "GET", path, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") }, config, nonces);
      if (result.log) log("request", { path, status: result.status, note: result.log });
      response.writeHead(result.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result.json));
    } catch (error) {
      log("error", { path, message: error instanceof Error ? error.message.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]") : "unknown" });
      response.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Execution worker error." }));
    }
  });
});

server.listen(port, "127.0.0.1", () => log("listening", { port, ordersEnabled: config.ordersEnabled, clients: config.allowedClientIds.size }));
