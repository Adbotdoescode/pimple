import Anthropic from "@anthropic-ai/sdk";
import { invoke } from "@tauri-apps/api/core";

let memo: Promise<Anthropic> | null = null;

async function loadClient(): Promise<Anthropic> {
  const key = await invoke<string | null>("get_secret", { name: "anthropic" });
  if (!key) throw new Error("Anthropic key missing — add it in Settings → Keys");
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1 });
}

/** Memoised client. A failed load (e.g. missing key) is not cached, so the next call retries. */
export async function getAnthropic(): Promise<Anthropic> {
  if (memo === null) {
    const p = loadClient();
    memo = p;
    p.catch(() => {
      if (memo === p) memo = null;
    });
  }
  return memo;
}

export function resetAnthropic(): void {
  memo = null;
}

/** Short, user-facing message for an SDK error. Never includes the key. */
export function readableApiError(err: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted || err instanceof Anthropic.APIUserAbortError) return new Error("cancelled");
  if (err instanceof Anthropic.AuthenticationError) return new Error("Anthropic rejected the key — check Settings → Keys");
  if (err instanceof Anthropic.RateLimitError) return new Error("Claude rate limit hit — try again shortly");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new Error("Claude request timed out");
  if (err instanceof Anthropic.APIError) {
    return new Error(`Claude API error${err.status ? ` ${err.status}` : ""}`);
  }
  if (err instanceof Error) return new Error(`Claude request failed: ${err.message.slice(0, 160)}`);
  return new Error("Claude request failed");
}
