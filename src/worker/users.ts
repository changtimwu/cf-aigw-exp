import type { Env } from "./env.js";

export type User = {
  sub: string;
  allowed_models: string[]; // empty array = unrestricted
  token_budget: number;     // 0 = unlimited
  tokens_used: number;
  created_at: number;
  last_request_at: number;
  revoked: boolean;
};

const DEFAULT_ALLOWED_MODELS = ["gpt-4o-mini", "whisper-1"];
const DEFAULT_TOKEN_BUDGET = 100_000;

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

export async function getUserByApiKey(env: Env, apiKey: string): Promise<User | null> {
  if (!apiKey.startsWith(API_KEY_PREFIX)) return null;
  const hash = await hashApiKey(apiKey);
  const raw = await env.USERS.get(`apikey:${hash}`);
  return raw ? (JSON.parse(raw) as User) : null;
}

export async function getUserBySub(env: Env, sub: string): Promise<User | null> {
  const hash = await env.USERS.get(`sub:${sub}`);
  if (!hash) return null;
  const raw = await env.USERS.get(`apikey:${hash}`);
  return raw ? (JSON.parse(raw) as User) : null;
}

export type CreateUserInput = {
  sub: string;
  allowed_models?: string[];
  token_budget?: number;
};

export async function createUser(
  env: Env,
  input: CreateUserInput,
): Promise<{ user: User; api_key: string }> {
  const existing = await env.USERS.get(`sub:${input.sub}`);
  if (existing) {
    throw new HttpError(409, "user_already_exists");
  }
  const api_key = generateApiKey();
  const hash = await hashApiKey(api_key);
  const now = Math.floor(Date.now() / 1000);
  const user: User = {
    sub: input.sub,
    allowed_models: input.allowed_models ?? DEFAULT_ALLOWED_MODELS,
    token_budget: input.token_budget ?? DEFAULT_TOKEN_BUDGET,
    tokens_used: 0,
    created_at: now,
    last_request_at: 0,
    revoked: false,
  };
  await env.USERS.put(`apikey:${hash}`, JSON.stringify(user));
  await env.USERS.put(`sub:${input.sub}`, hash);
  return { user, api_key };
}

export async function revokeUser(env: Env, sub: string): Promise<User | null> {
  const hash = await env.USERS.get(`sub:${sub}`);
  if (!hash) return null;
  const raw = await env.USERS.get(`apikey:${hash}`);
  if (!raw) return null;
  const user = JSON.parse(raw) as User;
  user.revoked = true;
  await env.USERS.put(`apikey:${hash}`, JSON.stringify(user));
  return user;
}

export async function resetUsage(env: Env, sub: string): Promise<User | null> {
  const hash = await env.USERS.get(`sub:${sub}`);
  if (!hash) return null;
  const raw = await env.USERS.get(`apikey:${hash}`);
  if (!raw) return null;
  const user = JSON.parse(raw) as User;
  user.tokens_used = 0;
  await env.USERS.put(`apikey:${hash}`, JSON.stringify(user));
  return user;
}

export async function listUsers(env: Env): Promise<User[]> {
  const out: User[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.USERS.list({ prefix: "apikey:", cursor });
    for (const k of list.keys) {
      const raw = await env.USERS.get(k.name);
      if (raw) out.push(JSON.parse(raw) as User);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return out;
}

// Increment usage by addedTokens; called from a waitUntil after the response
// is parsed. KV writes are eventually consistent and rate-limited (~1/s per
// key globally) — acceptable for PoC scale, document as a Phase-3 limitation.
export async function incrementUsage(
  env: Env,
  user: User,
  apiKeyHash: string,
  addedTokens: number,
): Promise<void> {
  if (addedTokens <= 0) return;
  user.tokens_used += addedTokens;
  user.last_request_at = Math.floor(Date.now() / 1000);
  await env.USERS.put(`apikey:${apiKeyHash}`, JSON.stringify(user));
}

export class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}
