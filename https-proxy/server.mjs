#!/usr/bin/env node
/**
 * pi-web-voice-https — zero-dependency TLS wrapper for voice dictation.
 *
 * Browsers only grant microphone access in a secure context: localhost works
 * out of the box, but phones and other LAN devices need HTTPS. This proxy
 * terminates TLS for the pi-web-voice server using a locally-generated CA
 * (auto-created on first run — no setup), so after a one-time CA install on
 * each device, voice works over the LAN.
 *
 * Usage:
 *   pi-web-voice-https                 # proxies https://0.0.0.0:8443 -> http://127.0.0.1:8080
 *
 * Env:
 *   PORT                HTTPS listen port         (default 8443)
 *   TARGET              upstream pi-web origin    (default http://127.0.0.1:8080)
 *   PI_WEB_HTTPS_DATA   cert/state directory      (default ~/.local/share/pi-web-https)
 *   PI_WEB_HTTPS_CERT / PI_WEB_HTTPS_KEY / PI_WEB_HTTPS_CA — explicit overrides
 *
 * Device onboarding (once per phone/tablet):
 *   1. Safari -> https://<lan-ip>:8443/pi-web-ca.crt (proceed past the warning)
 *   2. Settings -> Profile Downloaded -> Install
 *   3. Settings -> General -> About -> Certificate Trust Settings ->
 *      enable full trust for "pi-web Local Root CA"
 *
 * Implementation notes:
 *   - SSE (pi-web-voice's RPC transport) is piped byte-for-byte — streams
 *     stay live.
 *   - The client's Host header is passed through untouched and
 *     x-forwarded-proto is set: pi-web-voice's request-security check
 *     validates the browser's Origin authority against Host, so rewriting
 *     Host would flag every browser request as cross-site.
 *   - Hop-by-hop headers are stripped; WebSocket-style upgrades are piped
 *     through for future transports.
 */

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureCerts } from "./gen-certs.mjs";

const PORT = Number(process.env.PORT || 8443);
const TARGET = process.env.TARGET || "http://127.0.0.1:8080";
const DATA_DIR = process.env.PI_WEB_HTTPS_DATA || join(homedir(), ".local", "share", "pi-web-https");

// Auto-generate on first run; pass force=false so existing certs are reused.
const certs = ensureCerts(DATA_DIR, false);
const TLS = {
  cert: readFileSync(process.env.PI_WEB_HTTPS_CERT || certs.serverCert),
  key: readFileSync(process.env.PI_WEB_HTTPS_KEY || certs.serverKey),
};
const CA_PATH = process.env.PI_WEB_HTTPS_CA || certs.caCert;

const target = new URL(TARGET);

// Hop-by-hop headers must not be forwarded (RFC 9110 §7.6.1).
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const server = https.createServer(TLS, (req, res) => {
  // CA distribution endpoint so devices can install the trust profile from
  // the same host they're trying to reach (Safari: proceed past the warning,
  // download, install, enable full trust).
  if (req.url === "/pi-web-ca.crt") {
    try {
      const ca = readFileSync(CA_PATH);
      res.writeHead(200, {
        "content-type": "application/x-x509-ca-cert",
        "content-disposition": 'attachment; filename="pi-web-root-ca.crt"',
      });
      res.end(ca);
    } catch {
      res.writeHead(404).end();
    }
    return;
  }

  const upstream = http.request(
    target,
    {
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        // Preserve the CLIENT's Host (see module doc) — pi-web-voice's
        // request-security check requires Origin authority === Host authority.
        "x-forwarded-proto": "https",
        "x-forwarded-host": req.headers.host ?? "",
      },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res); // streams — SSE stays live
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end(`pi-web-voice-https: upstream error: ${err.message}`);
  });
  req.pipe(upstream);
});

// No websocket consumers today (pi-web is SSE), but handle upgrades anyway so
// future transports don't silently break through the wrapper.
server.on("upgrade", (req, socket) => {
  const upstream = http.request(
    target,
    { method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-proto": "https" } },
  );
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = [];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      if (!HOP_BY_HOP.has(upRes.rawHeaders[i].toLowerCase())) {
        lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      }
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on("error", () => socket.destroy());
  req.pipe(upstream);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pi-web-voice-https: https://0.0.0.0:${PORT} -> ${TARGET}`);
  console.log(`pi-web-voice-https: CA at ${CA_PATH} — devices: https://<lan-ip>:${PORT}/pi-web-ca.crt`);
});
