// Direct WS to OpenAI, bypassing AI Gateway. Tells us whether
// gpt-realtime-whisper works at all in our environment.

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import WebSocket from "ws";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("set OPENAI_API_KEY (source ./tmp/oai.env)");
  process.exit(2);
}

// Two URL paths to test:
//  - PATH=session     → /v1/realtime?model=<session-model>  (bidirectional realtime; need a session model)
//  - PATH=transcribe  → /v1/realtime?intent=transcription   (pure transcription; no session model needed)
const path = process.env.PATH_MODE ?? "transcribe";
const sessionModel = process.env.SESSION_MODEL ?? "gpt-realtime";
const transcriptionModel = process.env.TRANSCRIPTION_MODEL ?? "gpt-realtime-whisper";
const url =
  path === "transcribe"
    ? `wss://api.openai.com/v1/realtime?intent=transcription`
    : `wss://api.openai.com/v1/realtime?model=${sessionModel}`;
console.log(`[config] path=${path}, session=${sessionModel}, transcription=${transcriptionModel}`);
const audioPath = process.env.AUDIO_PATH ?? "samples/hello-24k.pcm";

const sendBeta = process.env.SEND_BETA !== "0";
const wsHeaders: Record<string, string> = { Authorization: `Bearer ${KEY}` };
if (sendBeta) wsHeaders["OpenAI-Beta"] = "realtime=v1";
console.log(`[config] send OpenAI-Beta header: ${sendBeta}`);
const ws = new WebSocket(url, { headers: wsHeaders });

const seen = new Set<string>();
const rateLimitsSamples: unknown[] = [];

ws.on("upgrade", (res) => {
  console.log(`[upgrade] HTTP ${res.statusCode} ${res.statusMessage}`);
});

ws.on("unexpected-response", (_req, res) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => {
    console.log(`[unexpected-response] HTTP ${res.statusCode}`);
    console.log(`  body: ${Buffer.concat(chunks).toString("utf8")}`);
    process.exit(2);
  });
});

ws.on("open", () => {
  console.log("[open] socket established");
  // Only set what we need; keep the server's default turn_detection.
  ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: { model: transcriptionModel, language: "en" },
          },
        },
      },
    }),
  );

  if (existsSync(audioPath)) {
    const pcm = readFileSync(audioPath);
    const CHUNK = 9600;
    let off = 0;
    const tick = setInterval(() => {
      if (off >= pcm.length) {
        clearInterval(tick);
        ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        console.log("[client] audio.commit sent");
        return;
      }
      const slice = pcm.subarray(off, Math.min(off + CHUNK, pcm.length));
      off += CHUNK;
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: slice.toString("base64") }));
    }, 100);
  }
});

ws.on("message", (data) => {
  let parsed: { type?: string };
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    console.log(`[binary]`);
    return;
  }
  const t = parsed.type ?? "(no type)";
  const first = !seen.has(t);
  seen.add(t);
  if (t === "rate_limits.updated") rateLimitsSamples.push(parsed);
  if (first) {
    console.log(`[first ${t}]`, JSON.stringify(parsed).slice(0, 500));
  } else {
    const p = parsed as Record<string, unknown>;
    const summary =
      typeof p.delta === "string"
        ? `delta="${(p.delta as string).slice(0, 60)}"`
        : typeof p.transcript === "string"
          ? `transcript="${(p.transcript as string).slice(0, 80)}"`
          : "";
    console.log(`[${t}] ${summary}`);
  }
});

ws.on("close", (code, reason) => {
  console.log(`\n[close] code=${code} reason=${reason.toString() || "(none)"}`);
  console.log("seen:", [...seen].sort().join(", "));
  if (rateLimitsSamples.length > 0) {
    console.log("\n=== rate_limits.updated ===");
    for (const s of rateLimitsSamples) console.log(JSON.stringify(s, null, 2));
  }
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[error]", err);
});

setTimeout(() => {
  console.log("[timeout] 25s, closing");
  ws.close();
}, 25_000);
