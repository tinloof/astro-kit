---
"@tinloof/astro-ios-backnav-fix": patch
"@tinloof/astro-prefetch": patch
---

Set `publishConfig.access` to `"public"` so scoped publishes never default to restricted — both manual `npm publish` and the changesets CI release now go out public, and new `@tinloof/*` packages copying this manifest inherit the safe default.
