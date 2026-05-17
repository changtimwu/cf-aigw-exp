// demo-chat: non-streaming chat completion.
//
// ──────────────────────────────────────────────────────────────────────
//  BEFORE (your current code — calling OpenAI direct):
//
//    const openai = new OpenAI({ apiKey: "sk-..." });
//
//  AFTER (this demo — calling the company Worker):
//
//    const openai = new OpenAI({
//      apiKey: process.env.USER_API_KEY,
//      baseURL: process.env.WORKER_URL,
//    });
//
//  That is the ENTIRE diff. Everything below — the call to
//  `openai.chat.completions.create(...)`, the response shape, error
//  handling — is identical to what you do today.
// ──────────────────────────────────────────────────────────────────────

import "dotenv/config";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.USER_API_KEY!,
  baseURL: process.env.WORKER_URL!,
});

async function main() {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: "Say hi and tell me which model you are." },
    ],
  });

  console.log(res.choices[0].message.content);
  console.log("---");
  console.log(`model:  ${res.model}`);
  console.log(`tokens: ${res.usage?.total_tokens}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
