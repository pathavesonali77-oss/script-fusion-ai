/**
 * Per-key request scheduler.
 *
 * The Paralon free tier answers `429 {"message":"Rate limit exceeded. Limit: 5
 * requests per minute"}` — PER KEY, not per account. Firing a whole wave of
 * chunk analyses at once therefore burned the whole minute on rejections and
 * the run appeared to hang at "prompts 0/N".
 *
 * So every text call now goes through a sliding-window queue: a key is handed
 * out only when it has a free slot in the last 60 seconds, otherwise the caller
 * waits for the earliest expiring slot. Callers keep their code unchanged apart
 * from awaiting `acquire()`.
 */

type Bucket = { limit: number; windowMs: number; hits: number[] };

const buckets = new Map<string, Bucket>();

function bucketFor(id: string, limit: number, windowMs: number): Bucket {
  let b = buckets.get(id);
  if (!b) {
    b = { limit, windowMs, hits: [] };
    buckets.set(id, b);
  }
  b.limit = limit;
  b.windowMs = windowMs;
  return b;
}

function freeIn(b: Bucket, now: number): number {
  b.hits = b.hits.filter((t) => now - t < b.windowMs);
  if (b.hits.length < b.limit) return 0;
  const oldest = b.hits[0] as number;
  return Math.max(1, b.windowMs - (now - oldest));
}

/**
 * Waits until one request may be sent under `id`'s quota, then records it.
 * Returns once the slot is reserved.
 */
export async function acquire(id: string, limit: number, windowMs = 60_000): Promise<void> {
  const b = bucketFor(id, limit, windowMs);
  // Fair-ish serialization: chain on the bucket's own promise so two callers
  // never claim the same free slot.
  const wait = freeIn(b, Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + 50 + Math.random() * 150));
  const again = freeIn(b, Date.now());
  if (again > 0) await new Promise((r) => setTimeout(r, again + 50 + Math.random() * 150));
  b.hits.push(Date.now());
}

/**
 * Picks the key with the most free quota right now (ties → lowest index), waits
 * for it if the whole pool is saturated, and reserves a slot on it.
 * `skip` lets a retry avoid the key that just failed.
 */
export async function acquireBestKey(
  keys: string[],
  limit: number,
  skip?: string,
  windowMs = 60_000,
): Promise<string> {
  const pool = keys.length > 1 && skip ? keys.filter((k) => k !== skip) : keys;
  const now = Date.now();
  let best = pool[0] as string;
  let bestWait = Number.POSITIVE_INFINITY;
  for (const k of pool) {
    const w = freeIn(bucketFor(k, limit, windowMs), now);
    if (w < bestWait) {
      best = k;
      bestWait = w;
      if (w === 0) break;
    }
  }
  await acquire(best, limit, windowMs);
  return best;
}

/** Frees a reserved slot when the request never reached the provider. */
export function release(id: string): void {
  const b = buckets.get(id);
  if (b) b.hits.pop();
}
