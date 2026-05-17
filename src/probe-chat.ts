import { openai, describeMode } from "./client.js";
import { openaiBaseURL } from "./config.js";

async function main() {
  console.log(`Gateway:  ${openaiBaseURL}`);
  console.log(`Mode:     ${describeMode()}`);
  console.log(`Sending:  chat.completions.create gpt-4o-mini ...\n`);

  const t0 = Date.now();
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a terse assistant. One short sentence." },
      { role: "user", content: "Say hi and tell me which model you are." },
    ],
  });
  const ms = Date.now() - t0;

  const choice = res.choices[0];
  console.log("=== response ===");
  console.log(choice.message.content);
  console.log("\n=== meta ===");
  console.log(`elapsed:        ${ms} ms`);
  console.log(`model:          ${res.model}`);
  console.log(`prompt_tokens:  ${res.usage?.prompt_tokens}`);
  console.log(`output_tokens:  ${res.usage?.completion_tokens}`);
  console.log(`finish_reason:  ${choice.finish_reason}`);
  console.log(`response_id:    ${res.id}`);
}

main().catch((err) => {
  console.error("probe-chat failed:");
  console.error(err);
  process.exit(1);
});
