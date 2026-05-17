// One-off spike: connect to CF AI Gateway over WebSocket for OpenAI
// Realtime, with NO Authorization header (testing BYOK behavior), send a
// transcription session config + audio, and log every server event so we
// can see what `rate_limits.updated` actually looks like.
//
// Run:  npm run spike:realtime

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import WebSocket from "ws";

function devVar(key: string): string | undefined {
  if (!existsSync(".dev.vars")) return undefined;
  for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && m[1] === key) {
      let v = m[2]!;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  }
  return undefined;
}

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? "15bfe332876061d9a548a4f3d6835657";
const GATEWAY_ID = process.env.CF_AIGW_ID ?? "aigw-exp-poc";
const CF_TOKEN = process.env.CF_AIGW_TOKEN ?? devVar("CF_AIGW_TOKEN");
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const AUDIO_PATH = process.env.AUDIO_PATH ?? "samples/hello-24k.pcm";

if (!CF_TOKEN) {
  console.error("Need CF_AIGW_TOKEN in env or .dev.vars");
  process.exit(2);
}
if (!existsSync(AUDIO_PATH)) {
  console.error(`Missing audio at ${AUDIO_PATH}.`);
  process.exit(2);
}

const path = process.env.PATH_MODE ?? "transcribe"; // "transcribe" or "session"
const sessionModel = process.env.SESSION_MODEL ?? "gpt-realtime";
const transcriptionModel = process.env.TRANSCRIPTION_MODEL ?? "gpt-realtime-whisper";
const qs =
  path === "transcribe"
    ? "intent=transcription"
    : `model=${sessionModel}`;
const url = `wss://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/openai?${qs}`;

const mode = process.argv[2] ?? "byok"; // "byok" → no Authorization; "passthrough" → include Authorization
const sendBeta = process.env.SEND_BETA === "1"; // GA shape by default
const headers: Record<string, string> = {
  "cf-aig-authorization": `Bearer ${CF_TOKEN}`,
};
if (sendBeta) headers["OpenAI-Beta"] = "realtime=v1";
if (mode === "passthrough") {
  if (!OPENAI_KEY) {
    console.error("passthrough mode needs OPENAI_API_KEY");
    process.exit(2);
  }
  headers["Authorization"] = `Bearer ${OPENAI_KEY}`;
}

console.log(`mode:    ${mode}`);
console.log(`path:    ${path}, transcription=${transcriptionModel}`);
console.log(`url:     ${url}`);
console.log(`headers: ${Object.keys(headers).join(", ")}`);
console.log();

const ws = new WebSocket(url, { headers });

ws.on("unexpected-response", (_req, res) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => {
    console.log(`[unexpected-response] HTTP ${res.statusCode}`);
    console.log(`  headers: ${JSON.stringify(res.headers, null, 2)}`);
    console.log(`  body:    ${Buffer.concat(chunks).toString("utf8")}`);
    process.exit(2);
  });
});

ws.on("upgrade", (res) => {
  console.log(`[upgrade] HTTP ${res.statusCode} ${res.statusMessage}`);
  console.log(`  response headers cf-ray=${res.headers["cf-ray"]} cf-aig=${res.headers["cf-aig-event-id"] ?? ""}`);
});

const seenEventTypes = new Set<string>();
const rateLimitsSamples: unknown[] = [];

ws.on("open", () => {
  console.log("[open] socket established");
  // Minimal session.update — keep server-default turn_detection.
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

  // Stream the audio file in ~100ms chunks (4800 samples * 2 bytes = 9600 bytes).
  const pcm = readFileSync(AUDIO_PATH);
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
    ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: slice.toString("base64"),
      }),
    );
  }, 100);
});

ws.on("message", (data) => {
  const text = data.toString();
  let parsed: { type?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log(`[binary?] ${text.slice(0, 120)}`);
    return;
  }
  const t = parsed.type ?? "(no type)";
  const firstTime = !seenEventTypes.has(t);
  seenEventTypes.add(t);
  if (t === "rate_limits.updated") rateLimitsSamples.push(parsed);
  // Print full payload on first sight; otherwise a compact one-liner.
  if (firstTime) {
    console.log(`[server first ${t}]`, JSON.stringify(parsed, null, 2));
  } else {
    const summary = (() => {
      const p = parsed as Record<string, unknown>;
      if (typeof p.delta === "string") return `delta="${(p.delta as string).slice(0, 60)}"`;
      if (typeof p.transcript === "string") return `transcript="${(p.transcript as string).slice(0, 80)}"`;
      return "";
    })();
    console.log(`[server ${t}] ${summary}`);
  }
});

ws.on("close", (code, reason) => {
  console.log(`\n[close] code=${code} reason=${reason.toString() || "(none)"}`);
  console.log("event types seen:", [...seenEventTypes].sort().join(", "));
  if (rateLimitsSamples.length > 0) {
    console.log("\n=== rate_limits.updated samples ===");
    for (const s of rateLimitsSamples) console.log(JSON.stringify(s, null, 2));
  }
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[error]", err);
  process.exit(1);
});

// Hard timeout — 20 seconds is plenty for a short audio sample.
setTimeout(() => {
  console.log("\n[timeout] closing after 20s");
  ws.close();
}, 20_000);
