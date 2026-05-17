// Mint a per-user JWT for testing the Phase 2 Worker.
//
//   npm run issue:token -- --sub alice
//   npm run issue:token -- --sub bob --ttl 1h
//
// Reads JWT_SECRET from .dev.vars (so the local Worker and this script share
// the same secret). For production deploys, the prod secret would be set
// via `wrangler secret put JWT_SECRET` and the issuer would live wherever
// your user-account system runs (not this script).

import { readFileSync } from "node:fs";
import { signJWT } from "../src/jwt.js";

function loadDevVars(path = ".dev.vars"): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

function parseTtl(input: string): number {
  const m = input.match(/^(\d+)(s|m|h|d)?$/);
  if (!m) throw new Error(`bad --ttl: ${input}`);
  const n = parseInt(m[1]!, 10);
  const unit = (m[2] ?? "s") as "s" | "m" | "h" | "d";
  const mul = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return n * mul;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i === process.argv.length - 1) return undefined;
  return process.argv[i + 1];
}

async function main() {
  const sub = flag("sub");
  if (!sub) {
    console.error("usage: issue-token --sub <user> [--ttl 24h]");
    process.exit(2);
  }
  const ttlSec = parseTtl(flag("ttl") ?? "24h");

  const dev = loadDevVars();
  const secret = process.env.JWT_SECRET ?? dev.JWT_SECRET;
  if (!secret) {
    console.error(
      "JWT_SECRET not found. Add it to .dev.vars (preferred for local) or export it in the shell.",
    );
    process.exit(2);
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ sub, iat: now, exp: now + ttlSec }, secret);
  console.log(token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
