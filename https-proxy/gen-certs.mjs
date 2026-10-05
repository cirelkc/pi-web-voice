/**
 * gen-certs — local CA + server certificate generation for the HTTPS proxy.
 *
 * Shared by two entry points:
 *   - server.mjs auto-generates on first boot (so `pi-web-voice-https` works
 *     with zero setup steps)
 *   - CLI: `node gen-certs.mjs` regenerates the server cert manually (e.g.
 *     after the machine's LAN IPs change; the CA persists across renewals)
 *
 * The server cert carries SANs for localhost, the hostname, and every LAN
 * IPv4, so any device on the network can trust https://<lan-ip>:8443 after
 * installing the CA. Validity is 820 days — the maximum iOS accepts for
 * certificates issued by a private (non-publicly-trusted) CA.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "pi-web-https");

export function pkiPaths(dataDir = DEFAULT_DATA_DIR) {
  const pki = join(dataDir, "pki");
  return {
    pki,
    caKey: join(pki, "ca.key"),
    caCert: join(pki, "ca.crt"),
    serverKey: join(pki, "server.key"),
    serverCert: join(pki, "server.crt"),
  };
}

/** Every non-loopback IPv4 on the machine (Linux + macOS). */
function lanIPv4s() {
  const ips = new Set();
  try {
    const out = execFileSync("ip", ["-o", "-4", "addr", "show"], { encoding: "utf8" });
    for (const m of out.matchAll(/inet (\d+\.\d+\.\d+\.\d+)\//g)) ips.add(m[1]);
  } catch {
    // Linux `ip` missing — try macOS ifconfig
    try {
      const out = execFileSync("ifconfig", [], { encoding: "utf8" });
      for (const m of out.matchAll(/inet (\d+\.\d+\.\d+\.\d+) /g)) {
        if (m[1] !== "127.0.0.1") ips.add(m[1]);
      }
    } catch {
      // No network tooling — loopback-only cert still works for localhost.
    }
  }
  ips.delete("127.0.0.1");
  return [...ips];
}

function openssl(args, quiet = true) {
  execFileSync("openssl", args, { stdio: quiet ? "ignore" : "inherit" });
}

function lanInterfaces() {
  try {
    return readdirSync("/sys/class/net");
  } catch {
    return [];
  }
}

/* GeneratedCerts: { caCert, serverCert, serverKey, sans, created } */

/**
 * Ensure a CA + server cert exist under dataDir. The CA is created once and
 * reused; the server cert is regenerated whenever missing — pass
 * forceRegenerate to pick up new LAN IPs.
 */
export function ensureCerts(dataDir = DEFAULT_DATA_DIR, forceRegenerate = false) {
  const { pki, caKey, caCert, serverKey, serverCert } = pkiPaths(dataDir);
  mkdirSync(pki, { recursive: true });

  if (!existsSync(caCert)) {
    openssl([
      "req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes",
      "-keyout", caKey, "-out", caCert,
      "-days", "3650",
      "-subj", "/CN=pi-web Local Root CA/O=pi-web-voice",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-addext", "subjectKeyIdentifier=hash",
    ]);
    console.log(`[certs] created local CA: ${caCert} (valid 3650 days)`);
  }

  // SANs: loopback + hostname + every LAN IPv4 (deduped, sorted for
  // deterministic certs across regenerations).
  const sans = ["DNS:localhost", "IP:127.0.0.1", "IP:::1"];
  const host = hostname();
  if (host) sans.push(`DNS:${host}`);
  for (const ip of lanIPv4s().sort()) sans.push(`IP:${ip}`);

  if (forceRegenerate || !existsSync(serverCert)) {
    const csr = join(pki, "server.csr");
    const extFile = join(pki, "server.ext");
    writeFileSync(
      extFile,
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "subjectKeyIdentifier=hash",
        `subjectAltName=${sans.join(",")}`,
        "",
      ].join("\n"),
    );
    openssl(["req", "-new", "-newkey", "rsa:2048", "-sha256", "-nodes", "-keyout", serverKey, "-subj", "/CN=pi-web Voice HTTPS", "-out", csr]);
    openssl([
      "x509", "-req", "-sha256", "-in", csr,
      "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
      "-days", "820", "-extfile", extFile, "-out", serverCert,
    ]);
    rmSync(extFile);
    rmSync(csr);
    chmodSync(serverKey, 0o600);
    chmodSync(caKey, 0o600);
    console.log(`[certs] server cert written: ${serverCert} (valid 820 days)`);
    console.log(`[certs] SANs: ${sans.join(", ")}`);
    return { caCert, serverCert, serverKey, sans, created: true };
  }

  return { caCert, serverCert, serverKey, sans, created: false };
}

// Small fs helpers inlined to keep the proxy dependency-free.
import { chmodSync, rmSync, writeFileSync } from "node:fs";
export { lanInterfaces };
