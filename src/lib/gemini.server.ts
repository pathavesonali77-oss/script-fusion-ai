/**
 * Gemini text engine.
 *
 * Replaces the old Qwen / ParalonCloud setup completely.
 *
 * Rules baked in here:
 *  - Keys are used ONE AT A TIME (never in parallel). The pool only advances
 *    when the active key's DAILY quota is exhausted; a per-minute limit just
 *    makes the caller wait.
 *  - Models are tried newest first: 3.7 → 3.6 → 3.5 flash (5 RPM / 25 RPD each),
 *    and only when every key is out of daily quota on all of them do we fall
 *    back to the flash-lite models (500 RPD).
 *  - Every text call goes through one global queue, so two calls can never
 *    race the same key's rate limit.
 */

import { geminiKeys } from "./keys.server";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

/** Preferred models, best first. Flash-lite is the last-resort high-quota tier. */
export const MODELS = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
] as const;

/** Free-tier pacing for the flash tier: 5 requests per minute, per key. */
const MIN_GAP_MS = 12_500;

type Slot = { exhaustedUntil: number; lastUsed: number };

const slots = new Map<string, Slot>();
/** Model index the pool is currently working through. */
let modelIdx = 0;
/** Key index inside the active model. */
let keyIdx = 0;
/** Global serialization: one Gemini request in flight at a time. */
let chain: Promise<unknown> = Promise.resolve();

function slotFor(model: string, key: string): Slot {
  const id = `${model}::${key}`;
  let s = slots.get(id);
  if (!s) {
    s = { exhaustedUntil: 0, lastUsed: 0 };
    slots.set(id, s);
  }
  return s;
}

/** Next UTC midnight — when Google resets a daily (RPD) quota. */
function nextDailyReset(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    5,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Model that is disabled entirely (404 / not available to these keys). */
const deadModels = new Set<string>();

export type ChatOptions = {
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Total attempts across keys/models before giving up. */
  attempts?: number;
};

/**
 * One text completion. Queued behind every other text call, so the active key
 * is never hit in parallel.
 */
export function geminiChat(user: string, opts: ChatOptions = {}): Promise<string> {
  const run = chain.then(
    () => callGemini(user, opts),
    () => callGemini(user, opts),
  );
  chain = run.catch(() => undefined);
  return run;
}

async function callGemini(user: string, opts: ChatOptions): Promise<string> {
  const keys = geminiKeys();
  const attempts = opts.attempts ?? Math.max(6, keys.length * 2);
  let lastErr = "";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const picked = pickModelAndKey(keys);
    if (!picked) {
      throw new Error(
        "Every Gemini key has hit its daily quota on every model. Try again after the daily reset (midnight UTC).",
      );
    }
    const { model, key } = picked;
    const slot = slotFor(model, key);

    // 5 requests/minute per key: keep a fixed gap instead of collecting 429s.
    const gap = MIN_GAP_MS - (Date.now() - slot.lastUsed);
    if (gap > 0) await sleep(gap);
    slot.lastUsed = Date.now();

    try {
      const res = await fetch(`${API}/${model}:generateContent`, {
        method: "POST",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: user }] }],
          ...(opts.system
            ? { systemInstruction: { role: "system", parts: [{ text: opts.system }] } }
            : {}),
          generationConfig: {
            temperature: opts.temperature ?? 0.7,
            maxOutputTokens: opts.maxOutputTokens ?? 32_768,
            // Storyboard writing does not need long deliberation; keeping the
            // thinking budget low makes long scripts answer far faster.
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
      });

      if (res.ok) {
        const json = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = (json.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? "")
          .join("")
          .trim();
        if (text) return text;
        lastErr = "empty completion";
        continue;
      }

      const body = (await res.text().catch(() => "")).slice(0, 600);
      lastErr = `${res.status} ${body}`;

      if (res.status === 429) {
        if (/per\s*day|perday|requests per day|RequestsPerDay/i.test(body)) {
          // Daily quota gone on this key: park it until the reset and move to
          // the next key (never in parallel — just the next one in line).
          slot.exhaustedUntil = nextDailyReset();
          advanceKey(keys.length);
        } else {
          // Per-minute limit: wait it out on the same key.
          const m = /"?retryDelay"?:\s*"?(\d+)s/i.exec(body);
          await sleep(Math.min(70_000, (m ? Number(m[1]) : 25) * 1000 + 1500));
        }
        continue;
      }
      if (res.status === 404) {
        deadModels.add(model);
        continue;
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        // Bad key → skip it for the day; bad request → pointless to retry.
        if (res.status !== 400) {
          slot.exhaustedUntil = nextDailyReset();
          advanceKey(keys.length);
          continue;
        }
        break;
      }
      // 5xx: brief backoff, same key.
      await sleep(1200 * (attempt + 1));
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await sleep(800 * (attempt + 1));
    }
  }

  throw new Error(`Gemini request failed: ${lastErr}`);
}

/**
 * Current model + key. Walks keys first (one at a time), then steps down to
 * the next model once every key is out of daily quota for the current one.
 */
function pickModelAndKey(keys: string[]): { model: string; key: string } | null {
  const now = Date.now();
  for (let mStep = 0; mStep < MODELS.length; mStep++) {
    const mi = (modelIdx + mStep) % MODELS.length;
    const model = MODELS[mi] as string;
    if (deadModels.has(model)) continue;
    for (let kStep = 0; kStep < keys.length; kStep++) {
      const ki = (keyIdx + kStep) % keys.length;
      const key = keys[ki] as string;
      if (slotFor(model, key).exhaustedUntil > now) continue;
      modelIdx = mi;
      keyIdx = ki;
      return { model, key };
    }
  }
  return null;
}

function advanceKey(total: number) {
  keyIdx = (keyIdx + 1) % total;
  // A full lap means this model is spent for the day on every key.
  if (keyIdx === 0) modelIdx = (modelIdx + 1) % MODELS.length;
}

/** Small status read-out for the UI. */
export function geminiStatus(): { model: string; keyIndex: number; keys: number } {
  const keys = geminiKeys();
  return { model: MODELS[modelIdx] as string, keyIndex: keyIdx + 1, keys: keys.length };
}
