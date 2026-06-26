# @tinloof/astro-prefetch

## 0.1.2

### Patch Changes

- 687283b: Support Astro 7 by relaxing the `astro` peer dependency to `^5 || ^6 || ^7`.

## 0.1.1

### Patch Changes

- 3f86e41: Set `publishConfig.access` to `"public"` so scoped publishes never default to restricted — both manual `npm publish` and the changesets CI release now go out public, and new `@tinloof/*` packages copying this manifest inherit the safe default.
- 244e2aa: Widen the astro peer range to `^5.0.0 || ^6.0.0` — the loader-override contract (`astro:before-preparation`, writable `event.loader`, defaultLoader semantics, `preloadStyleLinks`) is verified identical between astro 5.18 and 6.4, and a full build + serve of the playground against astro 5.18.2 passes.

## 0.1.0

### Minor Changes

- a6c2331: Initial release: Next.js-style prefetching for Astro's ClientRouter — in-memory page cache with TTL + LRU, Intent-prioritized scheduler, tap/hover/viewport strategies plus a cursor-trajectory "proximity" predictor, navigation loader override (zero-network swaps, in-flight joins, miss population), and opt-in debug badge + overlay.
