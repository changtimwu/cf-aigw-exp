import OpenAI from "openai";
import { config, openaiBaseURL } from "./config.js";

// One OpenAI client wired to point at Cloudflare AI Gateway.
//
// Two auth modes are supported (see .env.example):
//  - BYOK mode: OPENAI_API_KEY is empty. The OpenAI provider key is stored
//    inside AI Gateway. The SDK still requires *some* string as apiKey, but
//    we strip the resulting `Authorization` header by setting it to null in
//    defaultHeaders — CF AI Gateway only substitutes the stored key when no
//    Authorization header arrives from the client. Auth to the gateway is
//    via `cf-aig-authorization`.
//  - Pass-through mode: OPENAI_API_KEY is set. The gateway forwards the
//    real OpenAI key upstream. Still requires `cf-aig-authorization` when
//    the gateway has Authenticated Gateway enabled.
const byok = !config.openaiKey;

export const openai = new OpenAI({
  baseURL: openaiBaseURL,
  apiKey: config.openaiKey ?? "sk-byok-placeholder",
  defaultHeaders: {
    "cf-aig-authorization": `Bearer ${config.gatewayToken}`,
    ...(byok ? { Authorization: null } : {}),
  },
});

export function describeMode(): string {
  return byok
    ? "BYOK (OPENAI_API_KEY empty; gateway substitutes its stored key; Authorization header stripped)"
    : "pass-through (OPENAI_API_KEY set; gateway forwards your key)";
}
