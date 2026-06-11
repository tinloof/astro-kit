/**
 * Client runtime for @tinloof/astro-prefetch.
 *
 * Astro's built-in prefetch only emits browser hints (<link rel="prefetch">,
 * speculation rules) whose responses JS can't read back. This runtime owns
 * the whole pipeline instead, the way Next.js's app router does:
 *
 *   links.ts ──(schedule/bump)──▶ scheduler.ts ──(fetch+store)──▶ cache.ts
 *   proximity.ts ──(trajectory hit)──▶ scheduler.ts
 *   navigation.ts ──(read / await-pending / populate-on-miss)──▶ cache.ts
 *
 * The integration injects `init(options)` on every page and sets
 * `prefetch: false` so the built-in doesn't run in parallel. Requires
 * <ClientRouter /> on every page. Module-level state survives
 * view-transition swaps: hoisted module scripts execute once per full page
 * load (the router marks them data-astro-exec).
 *
 * Inert in dev: the default loader's dev-only client:only preparation
 * (prepareForClientOnlyComponents) is not worth replicating.
 */

import {
  configureCache,
  type Entry,
  get,
  invalidate as invalidateCache,
  keyFor as keyForUrl,
  purgePending,
} from "./cache.js";
import { initLinks, type Strategy, updateLinkOptions } from "./links.js";
import { initNavigation } from "./navigation.js";
import {
  PROXIMITY_HIT_EVENT as HIT_EVENT,
  type ProximityOptions,
  setProximity,
} from "./proximity.js";
import { flushQueue, Priority, resetInFlight, schedule } from "./scheduler.js";

export type PrefetchOptions = {
  /**
   * Strategy for links without a data-astro-prefetch value.
   * Default "proximity": cursor-trajectory prediction (plus tap on touch)
   * is the prefetch trigger. Per-link data-astro-prefetch attributes
   * (tap/hover/viewport/proximity/false) always override.
   */
  defaultStrategy?: Strategy;
  /** Prefetch links without a data-astro-prefetch attribute. Default true. */
  prefetchAll?: boolean;
  /**
   * Cursor-trajectory predictor tuning (see ProximityOptions), or `false`
   * to disable the predictor entirely.
   */
  proximity?: Partial<ProximityOptions> | false;
  /**
   * How long a cached page stays fresh (ms). Default 30_000. A
   * `x-prefetch-stale-time` response header (seconds) overrides per page.
   */
  staleTimeMs?: number;
  /** Byte budget for the in-memory LRU cache. Default 50MB. */
  maxCacheBytes?: number;
  /**
   * Debug visuals: `true` enables the hit/miss badge and the proximity
   * overlay; an object picks individually. Loaded as a separate chunk only
   * when enabled. Default false.
   */
  debug?: boolean | { badge?: boolean; overlay?: boolean };
};

let inited = false;

export function init(options: PrefetchOptions = {}): void {
  if (import.meta.env.SSR || inited) {
    return;
  }
  inited = true;

  if (import.meta.env.DEV) {
    console.debug(
      "[@tinloof/astro-prefetch] inert in dev — the default loader handles client:only preparation"
    );
    return;
  }

  configureCache({
    staleTimeMs: options.staleTimeMs,
    maxCacheBytes: options.maxCacheBytes,
  });
  initNavigation();
  initLinks({
    defaultStrategy: options.defaultStrategy ?? "proximity",
    prefetchAll: options.prefetchAll ?? true,
  });
  setProximity(options.proximity ?? {});

  if (options.debug) {
    applyDebug(options.debug);
  }

  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      // bfcache restore: pending promises and in-flight counts belong to a
      // dead page lifecycle. Fulfilled entries stay; TTL ages them out.
      purgePending();
      flushQueue();
      resetInFlight();
    }
  });
  window.addEventListener("offline", flushQueue);
}

/**
 * Live-reconfigure any option after init — for control panels, A/B tests,
 * or runtime tuning. Only the keys present are applied. No-op before init
 * and in dev (where the runtime is inert).
 */
export function configure(options: Partial<PrefetchOptions>): void {
  if (import.meta.env.SSR || import.meta.env.DEV || !inited) {
    return;
  }
  configureCache({
    staleTimeMs: options.staleTimeMs,
    maxCacheBytes: options.maxCacheBytes,
  });
  if (
    options.defaultStrategy !== undefined ||
    options.prefetchAll !== undefined
  ) {
    updateLinkOptions({
      ...(options.defaultStrategy !== undefined && {
        defaultStrategy: options.defaultStrategy,
      }),
      ...(options.prefetchAll !== undefined && {
        prefetchAll: options.prefetchAll,
      }),
    });
  }
  if (options.proximity !== undefined) {
    setProximity(options.proximity);
  }
  if (options.debug !== undefined) {
    applyDebug(options.debug);
  }
}

let debugLoaded = false;

function applyDebug(
  debug: NonNullable<PrefetchOptions["debug"]> | false
): void {
  // Toggling off without ever having enabled: nothing to tear down, and no
  // reason to pull the chunk in.
  if (debug === false && !debugLoaded) {
    return;
  }
  debugLoaded = true;
  const badge =
    debug === true || (typeof debug === "object" && (debug.badge ?? true));
  const overlay =
    debug === true || (typeof debug === "object" && (debug.overlay ?? true));
  // Dynamic import: debug code stays out of the bundle when disabled.
  import("./debug.js")
    .then((m) => m.setDebug({ badge, overlay }))
    .catch(() => {
      // debug chunk failed to load — never break the page for visuals
    });
}

const PRIORITY_BY_NAME = {
  intent: Priority.Intent,
  default: Priority.Default,
  background: Priority.Background,
} as const;

/** Programmatic prefetch (replaces astro:prefetch's export). */
export function prefetch(
  url: string,
  opts?: { priority?: keyof typeof PRIORITY_BY_NAME }
): void {
  schedule(url, PRIORITY_BY_NAME[opts?.priority ?? "default"]);
}

/** Inspect a URL's cache entry (debugging / tests). */
export function getEntry(url: string): Entry | undefined {
  const key = keyForUrl(url);
  return key ? get(key) : undefined;
}

/** Drop one URL's cache entry, or everything when called without arguments. */
export function invalidate(url?: string): void {
  invalidateCache(url);
}

/** Document event fired for every link the proximity predictor prefetches. */
export const PROXIMITY_HIT_EVENT = HIT_EVENT;

export type { Entry } from "./cache.js";
export type { Strategy } from "./links.js";
export type { ProximityHitDetail, ProximityOptions } from "./proximity.js";
