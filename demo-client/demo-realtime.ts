// demo-realtime: streaming transcription over WebSocket
// (gpt-realtime-whisper, OpenAI's GA Realtime API for live audio).
//
// ──────────────────────────────────────────────────────────────────────
//  BEFORE (calling OpenAI direct):
//
//    const ws = new WebSocket(
//      "wss://api.openai.com/v1/realtime?intent=transcription",
//      { headers: { Authorization: `Bearer ${OPENAI_KEY}` } }
//    );
//
//  AFTER (calling our Worker):
//
//    const ws = new WebSocket(
//      `${WORKER_WS_URL}/v1/realtime?intent=transcription`,
//      { headers: { Authorization: `Bearer ${USER_API_KEY}` } }
//    );
//
//  Where `WORKER_WS_URL` is just WORKER_URL with `http` → `ws`.
//  Everything below — the events you send (session.update,
//  input_audio_buffer.append, input_audio_buffer.commit) and the
//  events you receive (conversation.item.input_audio_transcription
//  .delta / .completed) — is OpenAI's GA Realtime API verbatim. The
//  Worker is a transparent proxy on the wire.
//
//  No OpenAI-Beta header (deprecated). 24 kHz mono PCM16 audio,
//  base64-encoded inside the append events.
// ──────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import WebSocket from "ws";

const WORKER_URL = process.env.WORKER_URL!;
const USER_API_KEY = process.env.USER_API_KEY!;
const AUDIO_PATH = process.env.REALTIME_AUDIO_PATH ?? "hello-24k.pcm";

if (!existsSync(AUDIO_PATH)) {
  console.error(`No audio at ${AUDIO_PATH}.`);
  console.error(`Generate one with:`);
  console.error(`  ffmpeg -i any.wav -ar 24000 -ac 1 -f s16le hello-24k.pcm`);
  process.exit(2);
}

// http:// → ws://, https:// → wss://
const wsUrl = WORKER_URL.replace(/^http/i, "ws").replace(/\/$/, "") +
  "/v1/realtime?intent=transcription";

const ws = new WebSocket(wsUrl, {
  headers: { Authorization: `Bearer ${USER_API_KEY}` },
});

ws.on("open", () => {
  // Configure the session. Just set the transcription model; the server's
  // default VAD is what you want (overriding it errors for whisper).
  ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: { model: "gpt-realtime-whisper", language: "en" },
          },
        },
      },
    }),
  );

  // Stream the audio in ~100 ms chunks. Real apps stream from the mic
  // continuously and never call .commit — VAD does turn-taking.
  const pcm = readFileSync(AUDIO_PATH);
  const CHUNK = 9600; // 24 kHz × 2 bytes × 0.1 s
  let off = 0;
  const tick = setInterval(() => {
    if (off >= pcm.length) {
      clearInterval(tick);
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      return;
    }
    const slice = pcm.subarray(off, Math.min(off + CHUNK, pcm.length));
    off += CHUNK;
    ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: slice.toString("base64"),
      }),
    );
  }, 100);
});

ws.on("message", (raw) => {
  let event: { type?: string; delta?: string; transcript?: string };
  try {
    event = JSON.parse(raw.toString());
  } catch {
    return;
  }
  switch (event.type) {
    case "conversation.item.input_audio_transcription.delta":
      // Word-by-word live partials — what you'd render in the UI.
      process.stdout.write(event.delta ?? "");
      break;
    case "conversation.item.input_audio_transcription.completed":
      console.log("\n[final] " + event.transcript);
      break;
    case "error":
      console.error("[error]", event);
      break;
    // session.created, session.updated, VAD events, conversation.item.* —
    // ignore for a transcription-only flow.
  }
});

ws.on("close", (code) => {
  console.log(`\n[close] code=${code}`);
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[error]", err);
  process.exit(1);
});

// Hard cap so the demo always terminates.
setTimeout(() => ws.close(), 25_000);
