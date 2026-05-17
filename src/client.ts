import OpenAI from "openai";
import { config, openaiBaseURL } from "./config.js";

// One OpenAI client wired to point at Cloudflare AI Gateway.
//
// Two auth modes are supported (see .env.example):
//  - BYOK mode: OPENAI_API_KEY is empty. The OpenAI provider key is stored
//    inside AI Gateway. We still pass *some* string as apiKey because the
//    OpenAI SDK requires one — the gateway ignores it when a stored key
//    matches. We send the CF gateway auth token via `cf-aig-authorization`.
//  - Pass-through mode: OPENAI_API_KEY is set. The gateway forwards the
//    real OpenAI key upstream. Still requires `cf-aig-authorization` when
//    the gateway has Authenticated Gateway enabled.
export const openai = new OpenAI({
  baseURL: openaiBaseURL,
  apiKey: config.openaiKey ?? "sk-byok-placeholder",
  defaultHeaders: {
    "cf-aig-authorization": `Bearer ${config.gatewayToken}`,
  },
});

export function describeMode(): string {
  return config.openaiKey
    ? "pass-through (OPENAI_API_KEY set; gateway forwards your key)"
    : "BYOK (OPENAI_API_KEY empty; gateway substitutes its stored key)";
}
