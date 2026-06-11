<h1 align="center">
  Tinloof Astro Kit
</h1>

<p align="center">
  A collection of Astro integrations, components, and tools by Tinloof
</p>

This is an official Turborepo monorepo used for developing and maintaining Tinloof's Astro packages.

## Table

- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Included Packages](#included-packages)
- [Releasing](#releasing)
- [Useful Links](#useful-links)

## Prerequisites

Before you begin, ensure you have the following installed:

- ✅ Node.js 20+
- ✅ pnpm 10+

## Getting Started

1. Clone this repository

   ```bash
   git clone git@github.com:tinloof/astro-kit.git
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Start the development server:

   ```bash
   pnpm dev
   ```

## Included Packages

### [iOS Back Navigation Fix](./packages/ios-backnav-fix)

Fixes the back button not working in iOS Chrome/Edge when using the `ClientRouter` for view transitions.

## Releasing

Releases are managed with [Changesets](https://github.com/changesets/changesets).

1. Create a changeset describing your changes:

   ```bash
   pnpm changeset
   ```

2. Merge to `main`. The [release workflow](./.github/workflows/release.yml) opens a version PR; merging it publishes to npm.

## Useful Links

- [Astro Documentation](https://docs.astro.build/)
- [Astro Integration API](https://docs.astro.build/en/reference/integrations-reference/)
- [Turborepo Documentation](https://turbo.build/repo/docs)
- [Tinloof Website](https://tinloof.com)
