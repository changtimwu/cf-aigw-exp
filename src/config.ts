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

export const config = {
  accountId: required("CF_ACCOUNT_ID"),
  gatewayId: required("CF_AIGW_ID"),
  gatewayToken: required("CF_AIGW_TOKEN"),
  openaiKey: optional("OPENAI_API_KEY"),
  audioPath: process.env.AUDIO_PATH ?? "samples/hello.wav",
};

export const openaiBaseURL = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/openai`;
