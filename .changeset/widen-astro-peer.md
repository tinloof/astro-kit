---
"@tinloof/astro-prefetch": patch
---

Widen the astro peer range to `^5.0.0 || ^6.0.0` — the loader-override contract (`astro:before-preparation`, writable `event.loader`, defaultLoader semantics, `preloadStyleLinks`) is verified identical between astro 5.18 and 6.4, and a full build + serve of the playground against astro 5.18.2 passes.
