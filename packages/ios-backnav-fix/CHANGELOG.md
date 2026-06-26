# @tinloof/astro-ios-backnav-fix

## 0.1.2

### Patch Changes

- 687283b: Support Astro 7 by relaxing the `astro` peer dependency to `^5 || ^6 || ^7`.

## 0.1.1

### Patch Changes

- 3f86e41: Set `publishConfig.access` to `"public"` so scoped publishes never default to restricted — both manual `npm publish` and the changesets CI release now go out public, and new `@tinloof/*` packages copying this manifest inherit the safe default.

## 0.1.0

### Minor Changes

- Initial release
