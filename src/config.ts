import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

// The probes have two backends:
//  - direct: hit CF AI Gateway with cf-aig-authorization (Phase 1)
//  - worker: hit our Cloudflare Worker with a per-user JWT (Phase 2)
//
// Setting CF_WORKER_URL switches to worker mode. Setting USER_JWT supplies
// the per-user token; you can mint one with `npm run issue:token -- --sub <user>`.
export type Mode =
  | { kind: "direct"; openaiBaseURL: string; gatewayToken: string; openaiKey?: string }
  | { kind: "worker"; openaiBaseURL: string; userJwt: string; openaiKey?: string };

const accountId = required("CF_ACCOUNT_ID");
const workerUrl = optional("CF_WORKER_URL");
const openaiKey = optional("OPENAI_API_KEY");
const audioPath = process.env.AUDIO_PATH ?? "samples/hello.wav";

export const mode: Mode = (() => {
  if (workerUrl) {
    return {
      kind: "worker",
      openaiBaseURL: workerUrl.replace(/\/$/, ""),
      userJwt: required("USER_JWT"),
      openaiKey,
    };
  }
  const gatewayId = required("CF_AIGW_ID");
  return {
    kind: "direct",
    openaiBaseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openai`,
    gatewayToken: required("CF_AIGW_TOKEN"),
    openaiKey,
  };
})();

export const config = { accountId, audioPath };
