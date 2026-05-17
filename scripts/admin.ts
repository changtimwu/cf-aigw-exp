// Admin CLI for the Phase 3 Worker.
//
//   npm run admin -- create-user --sub alice
//   npm run admin -- create-user --sub bob --models gpt-4o-mini,whisper-1 --budget 50000
//   npm run admin -- list-users
//   npm run admin -- get-user --sub alice
//   npm run admin -- revoke-user --sub alice
//   npm run admin -- reset-usage --sub alice
//
// Reads ADMIN_TOKEN from .dev.vars (local) or env. The worker URL comes from
// CF_WORKER_URL in .env (or --url flag). For production deploys, point
// CF_WORKER_URL at the deployed Worker and set ADMIN_TOKEN in your shell.

import { readFileSync } from "node:fs";
import "dotenv/config";

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
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]!] = val;
  }
  return out;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i === process.argv.length - 1) return undefined;
  return process.argv[i + 1];
}

function require_(name: string, val: string | undefined): string {
  if (!val) {
    console.error(`missing required --${name}`);
    process.exit(2);
  }
  return val;
}

async function call(
  url: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url.replace(/\/$/, "") + path, {
    method,
    headers: {
      "x-admin-token": token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = { raw: await res.text() };
  }
  return { status: res.status, data };
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error(
      "usage: admin <create-user|list-users|get-user|revoke-user|reset-usage> [flags]",
    );
    process.exit(2);
  }

  const dev = loadDevVars();
  const url = flag("url") ?? process.env.CF_WORKER_URL ?? "http://localhost:8787";
  const token = process.env.ADMIN_TOKEN ?? dev.ADMIN_TOKEN;
  if (!token) {
    console.error("ADMIN_TOKEN not found. Set in .dev.vars or export in shell.");
    process.exit(2);
  }

  let result: { status: number; data: unknown };
  switch (cmd) {
    case "create-user": {
      const sub = require_("sub", flag("sub"));
      const models = flag("models");
      const budget = flag("budget");
      const audioBudget = flag("audio-budget");
      result = await call(url, token, "POST", "/admin/users", {
        sub,
        ...(models ? { allowed_models: models.split(",").map((s) => s.trim()) } : {}),
        ...(budget ? { token_budget: parseInt(budget, 10) } : {}),
        ...(audioBudget ? { audio_seconds_budget: parseInt(audioBudget, 10) } : {}),
      });
      break;
    }
    case "list-users":
      result = await call(url, token, "GET", "/admin/users");
      break;
    case "get-user": {
      const sub = require_("sub", flag("sub"));
      result = await call(url, token, "GET", `/admin/users/${encodeURIComponent(sub)}`);
      break;
    }
    case "revoke-user": {
      const sub = require_("sub", flag("sub"));
      result = await call(url, token, "DELETE", `/admin/users/${encodeURIComponent(sub)}`);
      break;
    }
    case "reset-usage": {
      const sub = require_("sub", flag("sub"));
      result = await call(
        url,
        token,
        "POST",
        `/admin/users/${encodeURIComponent(sub)}/reset-usage`,
      );
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }

  console.log(JSON.stringify(result.data, null, 2));
  if (result.status >= 400) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
