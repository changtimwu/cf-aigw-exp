import type { Env } from "./env.js";

// Static user identity + config. The live counters
// (tokens_used, audio_seconds_used, last_request_at) live in a Durable
// Object — see usage.ts.
export type UserRecord = {
  sub: string;
  allowed_models: string[];     // empty array = unrestricted
  token_budget: number;          // 0 = unlimited (REST chat tokens)
  audio_seconds_budget: number;  // 0 = unlimited (realtime audio seconds)
  created_at: number;
  revoked: boolean;
};

const DEFAULT_ALLOWED_MODELS = ["gpt-4o-mini", "whisper-1", "gpt-realtime-whisper"];
const DEFAULT_TOKEN_BUDGET = 100_000;
const DEFAULT_AUDIO_SECONDS_BUDGET = 600; // 10 minutes

const API_KEY_PREFIX = "aigwk_";

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function hashApiKey(apiKey: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return toHex(new Uint8Array(buf));
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return API_KEY_PREFIX + toHex(bytes);
}

export async function getUserByApiKey(env: Env, apiKey: string): Promise<UserRecord | null> {
  if (!apiKey.startsWith(API_KEY_PREFIX)) return null;
  const hash = await hashApiKey(apiKey);
  const raw = await env.USERS.get(`apikey:${hash}`);
  return raw ? (JSON.parse(raw) as UserRecord) : null;
}

export async function getUserBySub(env: Env, sub: string): Promise<UserRecord | null> {
  const hash = await env.USERS.get(`sub:${sub}`);
  if (!hash) return null;
  const raw = await env.USERS.get(`apikey:${hash}`);
  return raw ? (JSON.parse(raw) as UserRecord) : null;
}

export type CreateUserInput = {
  sub: string;
  allowed_models?: string[];
  token_budget?: number;
  audio_seconds_budget?: number;
};

export async function createUser(
  env: Env,
  input: CreateUserInput,
): Promise<{ user: UserRecord; api_key: string }> {
  const existing = await env.USERS.get(`sub:${input.sub}`);
  if (existing) {
    throw new HttpError(409, "user_already_exists");
  }
  const api_key = generateApiKey();
  const hash = await hashApiKey(api_key);
  const now = Math.floor(Date.now() / 1000);
  const user: UserRecord = {
    sub: input.sub,
    allowed_models: input.allowed_models ?? DEFAULT_ALLOWED_MODELS,
    token_budget: input.token_budget ?? DEFAULT_TOKEN_BUDGET,
    audio_seconds_budget: input.audio_seconds_budget ?? DEFAULT_AUDIO_SECONDS_BUDGET,
    created_at: now,
    revoked: false,
  };
  await env.USERS.put(`apikey:${hash}`, JSON.stringify(user));
  await env.USERS.put(`sub:${input.sub}`, hash);
  return { user, api_key };
}

export async function revokeUser(env: Env, sub: string): Promise<UserRecord | null> {
  const hash = await env.USERS.get(`sub:${sub}`);
  if (!hash) return null;
  const raw = await env.USERS.get(`apikey:${hash}`);
  if (!raw) return null;
  const user = JSON.parse(raw) as UserRecord;
  user.revoked = true;
  await env.USERS.put(`apikey:${hash}`, JSON.stringify(user));
  return user;
}

export async function listUsers(env: Env): Promise<UserRecord[]> {
  const out: UserRecord[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.USERS.list({ prefix: "apikey:", cursor });
    for (const k of list.keys) {
      const raw = await env.USERS.get(k.name);
      if (raw) out.push(JSON.parse(raw) as UserRecord);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return out;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}
