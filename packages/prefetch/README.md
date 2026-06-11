# @tinloof/astro-prefetch

Next.js-style prefetching for Astro's `<ClientRouter />`: an in-memory page cache the router swaps from, with a cursor-trajectory ("proximity") predictor that starts the request before hover even fires.

Astro's built-in prefetch only emits browser hints (`<link rel="prefetch">`, speculation rules) whose responses JavaScript can't read back — navigation still refetches. This integration owns the whole pipeline instead:

- **Cache** — entry state machine (`pending → fulfilled | rejected`), per-entry TTL, byte-budget LRU.
- **Scheduler** — Intent > Default > Background priority queue, in-flight dedup, concurrency caps (4/12, Next.js's values).
- **Triggers** — Astro's `tap` / `hover` / `viewport` strategies (`data-astro-prefetch` compatible; `load` is not supported) plus **`proximity`**: project the cursor's velocity `lookaheadMs` ahead and prefetch the link it's heading toward. Links rendered after page load (islands, mega menus) are picked up via mutation observation.
- **Navigation** — `astro:before-preparation` loader override: fresh hit swaps with **zero network**; a click during an in-flight prefetch **awaits that same request** (never two); misses populate the cache so back/forward becomes a hit. Every failure path falls back to Astro's default loader.

## Install

```bash
pnpm add @tinloof/astro-prefetch
```

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import prefetch from "@tinloof/astro-prefetch";

export default defineConfig({
  integrations: [prefetch()],
});
```

Requires `<ClientRouter />` from `astro:transitions` on every page. The built-in `prefetch` config is disabled automatically. Inert in `astro dev` (the dev loader has dev-only duties we don't replicate) — test with `astro build && astro preview`.

## Options

```js
prefetch({
  defaultStrategy: "proximity", // tap | hover | viewport | proximity
  prefetchAll: true,            // links without data-astro-prefetch participate
  proximity: {                  // or false to disable the predictor
    lookaheadMs: 150,           // how far ahead to project the cursor — the "how early" dial
    radiusPx: 64,               // extra hit area around each link's rect
    minSpeedPxS: 80,            // slower = drift; hover handles it
    maxSpeedPxS: 2500,          // faster = flick; overshoots
    sampleWindowMs: 80,         // velocity estimation window
    tickMs: 50,                 // evaluation throttle
  },
  staleTimeMs: 30_000,          // cache TTL; x-prefetch-stale-time response header (seconds) overrides
  maxCacheBytes: 50 * 1024 * 1024, // LRU budget
  debug: false,                 // true | { badge, overlay } — loaded as a separate chunk
});
```

Per-link `data-astro-prefetch="tap|hover|viewport|proximity|false"` always overrides `defaultStrategy`. Astro's `load` value is not supported — links carrying it are not prefetched.

### `debug`

`debug: true` enables:

- a **badge** (bottom-right) classifying each navigation: `CACHE HIT` / `AWAITED PREFETCH` / `CACHE MISS` / `DIRECT`, with elapsed ms
- a **proximity overlay**: each candidate link's hit area, the cursor's velocity ray to the projected point, live px/s, and a green flash on the link the predictor prefetches

## Programmatic API

```js
import { prefetch, invalidate, getEntry } from "@tinloof/astro-prefetch/client";

prefetch("/checkout", { priority: "intent" });
invalidate("/cart"); // after a mutation; no argument clears everything
```

## Server notes

- Prefetch requests carry `x-astro-prefetch: 1` — identify them for CDN rules or cheaper rendering. If the server varies on it, send `Vary: x-astro-prefetch`.
- Respond with `x-prefetch-stale-time: <seconds>` to control per-page TTL (floored at 30s).
- Responses with `Cache-Control: no-store` or `Vary: Cookie` are never cached.
- Personalized HTML: call `invalidate()` after login/cart mutations, or keep `staleTimeMs` short.

## Caveats

- The navigation consume path replicates internal behavior of astro 6.4.x's `transitions/router.js` defaultLoader (redirect replay, stylesheet preload). Re-check on major Astro upgrades; all failure paths fall back to the default loader.
- A view-transition swap is atomic: streamed pages are buffered before swapping (the default loader does the same). For slow streaming pages, move the slow data into `server:defer` islands — the cached shell swaps instantly and islands stream in fresh after.
