// probe-realtime: send a PCM audio sample to the Worker over WebSocket and
// log the streamed transcription. Uses the `ws` package (Node) as the
// client; the desktop app would use whichever WS client is convenient.
//
// Run after starting `npm run worker:dev` and provisioning a user:
//   export USER_API_KEY=$(npm run --silent admin -- create-user --sub alice | jq -r .api_key)
//   export CF_WORKER_URL=http://localhost:8787
//   npm run probe:realtime

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";

const WORKER_URL = process.env.CF_WORKER_URL ?? "http://localhost:8787";
const API_KEY = process.env.USER_API_KEY;
const AUDIO_PATH = process.env.AUDIO_PATH ?? "samples/hello-24k.pcm";
const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL ?? "gpt-realtime-whisper";

if (!API_KEY) {
  console.error("USER_API_KEY not set. Provision a user via:");
  console.error("  npm run admin -- create-user --sub <name>");
  process.exit(2);
}
const audio = resolve(AUDIO_PATH);
if (!existsSync(audio)) {
  console.error(`No audio at ${audio}. Generate with:`);
  console.error(`  ffmpeg -i samples/hello.wav -ar 24000 -ac 1 -f s16le samples/hello-24k.pcm`);
  process.exit(2);
}

const wsBase = WORKER_URL.replace(/^http/i, "ws").replace(/\/$/, "");
const wsUrl = `${wsBase}/v1/realtime?intent=transcription`;

console.log(`Worker: ${WORKER_URL}`);
console.log(`Audio:  ${audio}`);
console.log(`Model:  ${TRANSCRIPTION_MODEL}`);
console.log(`Opening ${wsUrl}\n`);

const ws = new WebSocket(wsUrl, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});

const seen = new Set<string>();
let liveLine = "";
let firstByteMs: number | null = null;
const t0 = Date.now();

ws.on("upgrade", (res) => {
  console.log(`[upgrade] HTTP ${res.statusCode}`);
});

ws.on("unexpected-response", (_req, res) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => {
    console.error(`[upgrade failed] HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`);
    process.exit(1);
  });
});

ws.on("open", () => {
  console.log("[open] worker accepted the WS");
  ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: { model: TRANSCRIPTION_MODEL, language: "en" },
          },
        },
      },
    }),
  );

  const pcm = readFileSync(audio);
  const CHUNK = 9600; // ~100 ms of 24 kHz mono PCM16
  let off = 0;
  const tick = setInterval(() => {
    if (off >= pcm.length) {
      clearInterval(tick);
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      console.log("\n[client] audio.commit sent");
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

ws.on("message", (data) => {
  let parsed: { type?: string; delta?: string; transcript?: string };
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return;
  }
  const t = parsed.type ?? "?";
  if (!seen.has(t)) seen.add(t);
  switch (t) {
    case "conversation.item.input_audio_transcription.delta":
      if (firstByteMs === null) firstByteMs = Date.now() - t0;
      liveLine += parsed.delta ?? "";
      process.stdout.write(parsed.delta ?? "");
      break;
    case "conversation.item.input_audio_transcription.completed":
      console.log("\n");
      console.log(`[completed] ${parsed.transcript}`);
      break;
    case "error":
      console.error("[error]", JSON.stringify(parsed));
      break;
    case "session.created":
    case "session.updated":
      console.log(`[${t}]`);
      break;
    default:
      // VAD / item / buffer events — quiet by default
      break;
  }
});

ws.on("close", (code, reason) => {
  console.log(`\n[close] code=${code} reason=${reason.toString() || "(none)"}`);
  console.log(`time_to_first_delta: ${firstByteMs ?? "n/a"} ms`);
  console.log(`event types seen:    ${[...seen].sort().join(", ")}`);
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[error]", err);
  process.exit(1);
});

setTimeout(() => {
  console.log("[timeout] 25s, closing");
  ws.close();
}, 25_000);
