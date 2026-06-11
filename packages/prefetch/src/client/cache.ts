/**
 * In-memory prefetch cache, modeled on Next.js's client segment cache,
 * adapted to whole-HTML documents:
 *
 *  - entry state machine: pending -> fulfilled | rejected
 *  - pending entries hold a promise that never rejects; a navigation that
 *    lands while a prefetch is in flight awaits it instead of refetching
 *  - per-entry staleAt TTL: `x-prefetch-stale-time` response header
 *    (seconds, floored at 30s) wins; default configurable via init()
 *  - rejected entries retryable after 10s
 *  - byte-budget LRU (configurable, default 50MB), evict oldest down to
 *    90%; Map insertion order doubles as LRU order
 *
 * HTML is stored as a string and parsed per consume — the router's swap is
 * destructive (swapBodyElement replaceWith), so a parsed Document can't be
 * cached.
 */

export type CacheKey = string;

export type PendingEntry = {
  key: CacheKey;
  state: "pending";
  /** Settles (never rejects) to the final entry; navigation awaits this. */
  promise: Promise<FulfilledEntry | RejectedEntry>;
};

export type FulfilledEntry = {
  key: CacheKey;
  state: "fulfilled";
  html: string;
  mediaType: DOMParserSupportedType;
  /** res.url when the prefetch followed a redirect, else null. */
  finalUrl: string | null;
  staleAt: number;
  size: number;
};

export type RejectedEntry = {
  key: CacheKey;
  state: "rejected";
  retryAt: number;
};

export type Entry = PendingEntry | FulfilledEntry | RejectedEntry;

const MIN_HEADER_STALE_MS = 30_000;
const REJECT_RETRY_MS = 10_000;
const EVICT_TO_RATIO = 0.9;

let defaultStaleMs = 30_000;
let maxBytes = 50 * 1024 * 1024;

export function configureCache(options: {
  staleTimeMs?: number;
  maxCacheBytes?: number;
}): void {
  if (options.staleTimeMs !== undefined) {
    defaultStaleMs = options.staleTimeMs;
  }
  if (options.maxCacheBytes !== undefined) {
    maxBytes = options.maxCacheBytes;
  }
}

const cache = new Map<CacheKey, Entry>();
let totalBytes = 0;

/** Normalized cache key: origin + pathname + search, hash stripped. Null for cross-origin/invalid. */
export function keyFor(url: string | URL): CacheKey | null {
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin) {
      return null;
    }
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

export function get(key: CacheKey): Entry | undefined {
  return cache.get(key);
}

/** Fulfilled and within TTL; touches LRU. Drops the entry when stale. */
export function readFresh(key: CacheKey): FulfilledEntry | null {
  const entry = cache.get(key);
  if (entry?.state !== "fulfilled") {
    return null;
  }
  if (Date.now() >= entry.staleAt) {
    remove(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function readPending(key: CacheKey): PendingEntry | null {
  const entry = cache.get(key);
  return entry?.state === "pending" ? entry : null;
}

/** True when there is no usable entry: missing, stale, or rejected past its retry window. */
export function shouldFetch(key: CacheKey): boolean {
  const entry = cache.get(key);
  if (!entry) {
    return true;
  }
  if (entry.state === "pending") {
    return false;
  }
  if (entry.state === "fulfilled") {
    return Date.now() >= entry.staleAt;
  }
  return Date.now() >= entry.retryAt;
}

export function setPending(
  key: CacheKey,
  promise: Promise<FulfilledEntry | RejectedEntry>
): PendingEntry {
  remove(key);
  const entry: PendingEntry = { key, state: "pending", promise };
  cache.set(key, entry);
  return entry;
}

export function fulfill(
  key: CacheKey,
  res: Response,
  html: string
): FulfilledEntry {
  const headerSeconds = Number(res.headers.get("x-prefetch-stale-time"));
  const ttl =
    Number.isFinite(headerSeconds) && headerSeconds > 0
      ? Math.max(headerSeconds * 1000, MIN_HEADER_STALE_MS)
      : defaultStaleMs;
  const mediaType = (res.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim();
  const entry: FulfilledEntry = {
    key,
    state: "fulfilled",
    html,
    mediaType:
      mediaType === "application/xhtml+xml"
        ? "application/xhtml+xml"
        : "text/html",
    finalUrl: res.redirected ? res.url : null,
    staleAt: Date.now() + ttl,
    // UTF-16 code units, 2 bytes each — close enough for budget accounting.
    size: html.length * 2,
  };
  remove(key);
  cache.set(key, entry);
  totalBytes += entry.size;
  evictIfNeeded();
  return entry;
}

export function reject(key: CacheKey): RejectedEntry {
  const entry: RejectedEntry = {
    key,
    state: "rejected",
    retryAt: Date.now() + REJECT_RETRY_MS,
  };
  remove(key);
  cache.set(key, entry);
  return entry;
}

export function remove(key: CacheKey): void {
  const entry = cache.get(key);
  if (!entry) {
    return;
  }
  if (entry.state === "fulfilled") {
    totalBytes -= entry.size;
  }
  cache.delete(key);
}

function evictIfNeeded(): void {
  if (totalBytes <= maxBytes) {
    return;
  }
  const evictTo = maxBytes * EVICT_TO_RATIO;
  for (const [key, entry] of cache) {
    if (totalBytes <= evictTo) {
      break;
    }
    // Never evict pending — a navigation may be awaiting its promise.
    if (entry.state === "pending") {
      continue;
    }
    if (entry.state === "fulfilled") {
      totalBytes -= entry.size;
    }
    cache.delete(key);
  }
}

/** Drop pending entries (bfcache restore: their promises belong to a dead lifecycle). */
export function purgePending(): void {
  for (const [key, entry] of cache) {
    if (entry.state === "pending") {
      cache.delete(key);
    }
  }
}

/** Drop one URL's entry, or everything when called without arguments. */
export function invalidate(url?: string): void {
  if (url === undefined) {
    cache.clear();
    totalBytes = 0;
    return;
  }
  const key = keyFor(url);
  if (key) {
    remove(key);
  }
}

const NO_STORE_RE = /no-store/i;
const VARY_COOKIE_RE = /(^|,)\s*cookie\s*(,|$)/i;

/** Responses that must not be served from a shared in-memory cache. */
export function isCacheableResponse(res: Response): boolean {
  const cacheControl = res.headers.get("cache-control") ?? "";
  if (NO_STORE_RE.test(cacheControl)) {
    return false;
  }
  const vary = res.headers.get("vary") ?? "";
  if (vary.trim() === "*" || VARY_COOKIE_RE.test(vary)) {
    return false;
  }
  return true;
}
