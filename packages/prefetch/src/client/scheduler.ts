/**
 * Prefetch scheduler, modeled on Next.js's segment-cache scheduler:
 *
 *  - priority queue: Intent (hover/tap/proximity) > Default (viewport) > Background
 *  - queued-task dedup with priority upgrade (hover bumps a queued viewport task)
 *  - in-flight dedup via the cache's pending state
 *  - concurrency caps: 4 default / 12 when the head task is intent (Next.js values)
 *  - microtask-batched pump
 *
 * Requests carry `x-astro-prefetch: 1` so the server/CDN can identify
 * prefetch traffic (the equivalent of Next.js's `next-router-prefetch: 1`).
 */

import {
  type CacheKey,
  type FulfilledEntry,
  fulfill,
  isCacheableResponse,
  keyFor,
  type RejectedEntry,
  reject,
  setPending,
  shouldFetch,
} from "./cache.js";

export const Priority = {
  Background: 0,
  Default: 1,
  Intent: 2,
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

type Task = {
  key: CacheKey;
  priority: Priority;
  seq: number;
};

const MAX_DEFAULT_CONCURRENCY = 4;
const MAX_INTENT_CONCURRENCY = 12;

const queue: Task[] = [];
const queuedByKey = new Map<CacheKey, Task>();
let inFlight = 0;
let seq = 0;
let pumpScheduled = false;

type NetworkInformation = {
  effectiveType?: string;
  saveData?: boolean;
};

const SLOW_EFFECTIVE_TYPE_RE = /2g/;

export function isSlowConnection(): boolean {
  const conn = (navigator as Navigator & { connection?: NetworkInformation })
    .connection;
  if (conn) {
    return (
      Boolean(conn.saveData) ||
      SLOW_EFFECTIVE_TYPE_RE.test(conn.effectiveType ?? "")
    );
  }
  return false;
}

export function schedule(url: string | URL, priority: Priority): void {
  const key = keyFor(url);
  if (!key) {
    return;
  }
  const u = new URL(key);
  if (u.pathname === location.pathname && u.search === location.search) {
    return;
  }
  if (!navigator.onLine) {
    return;
  }
  if (!shouldFetch(key)) {
    return;
  }

  const existing = queuedByKey.get(key);
  if (existing) {
    // Dedup + upgrade: hover over a queued viewport task moves it forward.
    if (priority > existing.priority) {
      existing.priority = priority;
    }
  } else {
    seq += 1;
    const task: Task = { key, priority, seq };
    queuedByKey.set(key, task);
    queue.push(task);
  }
  schedulePump();
}

function schedulePump(): void {
  if (pumpScheduled) {
    return;
  }
  pumpScheduled = true;
  queueMicrotask(pump);
}

function pump(): void {
  pumpScheduled = false;
  queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  while (queue.length > 0) {
    const head = queue[0];
    const cap =
      head.priority === Priority.Intent
        ? MAX_INTENT_CONCURRENCY
        : MAX_DEFAULT_CONCURRENCY;
    if (inFlight >= cap) {
      break;
    }
    queue.shift();
    queuedByKey.delete(head.key);
    // May have been fulfilled (or gone pending) since it was queued.
    if (!shouldFetch(head.key)) {
      continue;
    }
    run(head);
  }
}

function run(task: Task): void {
  inFlight += 1;
  const promise: Promise<FulfilledEntry | RejectedEntry> = (async () => {
    try {
      const res = await fetch(task.key, {
        headers: { "x-astro-prefetch": "1" },
        // Request priority hint; ignored where unsupported.
        priority: task.priority === Priority.Intent ? "high" : "low",
      } as RequestInit);
      const mediaType = (res.headers.get("content-type") ?? "")
        .split(";", 1)[0]
        .trim();
      if (
        res.status >= 500 ||
        (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") ||
        !isCacheableResponse(res)
      ) {
        return reject(task.key);
      }
      const html = await res.text();
      return fulfill(task.key, res, html);
    } catch {
      return reject(task.key);
    } finally {
      inFlight -= 1;
      if (queue.length > 0) {
        schedulePump();
      }
    }
  })();
  setPending(task.key, promise);
}

export function flushQueue(): void {
  queue.length = 0;
  queuedByKey.clear();
}

/** bfcache restore: in-flight bookkeeping belongs to a dead page lifecycle. */
export function resetInFlight(): void {
  inFlight = 0;
}
