// demo-stream: streaming chat completion.
//
// ──────────────────────────────────────────────────────────────────────
//  BEFORE / AFTER — same diff as demo-chat.ts (apiKey + baseURL).
//
//  The `for await (const chunk of stream)` loop is unchanged.
//  The Worker injects `stream_options.include_usage: true` for you
//  upstream so your existing streaming code keeps working AND we can
//  meter token usage; you don't need to set it yourself.
// ──────────────────────────────────────────────────────────────────────

import "dotenv/config";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.USER_API_KEY!,
  baseURL: process.env.WORKER_URL!,
});

async function main() {
  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    stream: true,
    messages: [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: "Count from 1 to 5, one number per line." },
    ],
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) process.stdout.write(delta);
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
