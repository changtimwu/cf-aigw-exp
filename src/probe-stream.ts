import { openai, describeMode } from "./client.js";
import { openaiBaseURL } from "./config.js";

async function main() {
  console.log(`Gateway:  ${openaiBaseURL}`);
  console.log(`Mode:     ${describeMode()}`);
  console.log(`Sending:  streaming chat.completions ...\n`);

  const t0 = Date.now();
  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    stream: true,
    messages: [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: "Count from 1 to 5, one number per line." },
    ],
  });

  let firstTokenMs: number | null = null;
  let total = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
      process.stdout.write(delta);
      total += delta;
    }
  }
  const totalMs = Date.now() - t0;
  console.log("\n\n=== meta ===");
  console.log(`time_to_first_token: ${firstTokenMs} ms`);
  console.log(`total_time:          ${totalMs} ms`);
  console.log(`chars:               ${total.length}`);
}

main().catch((err) => {
  console.error("probe-stream failed:");
  console.error(err);
  process.exit(1);
});
