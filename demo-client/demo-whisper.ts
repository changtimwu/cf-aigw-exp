// demo-whisper: Whisper-1 transcription (request/response, REST).
//
// ──────────────────────────────────────────────────────────────────────
//  BEFORE / AFTER — same diff (apiKey + baseURL).
//
//  Multipart upload, file streams, the audio.transcriptions.create
//  call shape — all identical to OpenAI direct.
//
//  Note: Whisper-1 is the REST model. If you want live partial
//  transcripts as the user speaks, use demo-realtime.ts instead.
// ──────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { createReadStream, existsSync } from "node:fs";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.USER_API_KEY!,
  baseURL: process.env.WORKER_URL!,
});

async function main() {
  const audio = process.env.WHISPER_AUDIO_PATH ?? "hello.wav";
  if (!existsSync(audio)) {
    console.error(`No audio at ${audio}. Drop any .wav/.mp3/.m4a in this folder and point WHISPER_AUDIO_PATH at it.`);
    process.exit(2);
  }

  const res = await openai.audio.transcriptions.create({
    file: createReadStream(audio),
    model: "whisper-1",
  });

  console.log(res.text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
