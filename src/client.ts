import OpenAI from "openai";
import { mode } from "./config.js";

// One OpenAI client wired to whichever backend `mode` selected.
//
//  - mode.kind === "direct": hit CF AI Gateway directly.
//      * If OPENAI_API_KEY is empty → BYOK: strip Authorization so the
//        gateway substitutes its stored key.
//      * If OPENAI_API_KEY is set → pass-through: forward the user-supplied
//        OpenAI key.
//      * Always send `cf-aig-authorization`.
//
//  - mode.kind === "worker": hit our Cloudflare Worker.
//      * `Authorization: Bearer <user-jwt>` — validated by the Worker.
//      * No `cf-aig-authorization` from us; the Worker holds the gateway
//        token server-side and injects it on the upstream hop.
const byok = mode.kind === "direct" && !mode.openaiKey;

const apiKey =
  mode.kind === "worker"
    ? mode.userJwt
    : (mode.openaiKey ?? "sk-byok-placeholder");

const defaultHeaders: Record<string, string | null> = {};
if (mode.kind === "direct") {
  defaultHeaders["cf-aig-authorization"] = `Bearer ${mode.gatewayToken}`;
  if (byok) defaultHeaders["Authorization"] = null;
}

export const openai = new OpenAI({
  baseURL: mode.openaiBaseURL,
  apiKey,
  defaultHeaders,
});

export function describeMode(): string {
  if (mode.kind === "worker") {
    return "via Cloudflare Worker (per-user JWT; Worker holds the gateway token)";
  }
  return byok
    ? "direct → AI Gateway (BYOK; Authorization stripped, stored key substituted)"
    : "direct → AI Gateway (pass-through; OPENAI_API_KEY forwarded)";
}
