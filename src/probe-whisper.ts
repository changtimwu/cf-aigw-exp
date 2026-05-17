import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import { openai, describeMode } from "./client.js";
import { config, openaiBaseURL } from "./config.js";

async function main() {
  const audio = resolve(config.audioPath);
  if (!existsSync(audio)) {
    console.error(`No audio file at ${audio}.`);
    console.error(`Set AUDIO_PATH in .env or drop a sample into samples/.`);
    console.error(`Any short .wav/.mp3/.m4a/.webm works for the probe.`);
    process.exit(2);
  }

  console.log(`Gateway:  ${openaiBaseURL}`);
  console.log(`Mode:     ${describeMode()}`);
  console.log(`Audio:    ${audio}`);
  console.log(`Sending:  audio.transcriptions.create whisper-1 ...\n`);

  const t0 = Date.now();
  const res = await openai.audio.transcriptions.create({
    file: createReadStream(audio),
    model: "whisper-1",
  });
  const ms = Date.now() - t0;

  console.log("=== transcription ===");
  console.log(res.text);
  console.log("\n=== meta ===");
  console.log(`elapsed: ${ms} ms`);
}

main().catch((err) => {
  console.error("probe-whisper failed:");
  console.error(err);
  process.exit(1);
});
