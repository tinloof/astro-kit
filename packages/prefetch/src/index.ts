import type { AstroIntegration } from "astro";
import type { PrefetchOptions } from "./client/index.js";

export type { PrefetchOptions } from "./client/index.js";
export type { Strategy } from "./client/links.js";
export type { ProximityOptions } from "./client/proximity.js";

/**
 * Next.js-style prefetching for Astro's ClientRouter.
 *
 * Replaces Astro's hint-based prefetch (whose responses JS can't read back)
 * with an in-memory cache the router swaps from: link observation with a
 * cursor-trajectory "proximity" predictor, an Intent-prioritized scheduler,
 * and an `astro:before-preparation` loader override that serves cached HTML
 * with zero network, joins in-flight prefetches, and populates the cache on
 * misses.
 *
 * Requires `<ClientRouter />` (astro:transitions) on every page. Astro's
 * built-in `prefetch` config is disabled automatically — this integration
 * owns the pipeline.
 *
 * @example
 * // astro.config.mjs
 * import prefetch from "@tinloof/astro-prefetch";
 * export default defineConfig({
 *   integrations: [
 *     prefetch({
 *       proximity: { lookaheadMs: 200, radiusPx: 80 },
 *       debug: true,
 *     }),
 *   ],
 * });
 */
export default function prefetch(
  options: PrefetchOptions = {}
): AstroIntegration {
  return {
    name: "@tinloof/astro-prefetch",
    hooks: {
      "astro:config:setup": ({
        config,
        updateConfig,
        injectScript,
        logger,
      }) => {
        if (config.prefetch) {
          logger.warn(
            "Astro's built-in prefetch is enabled in your config; disabling it — @tinloof/astro-prefetch owns link observation and fetching. Configure strategies on the integration instead."
          );
        }
        // Scalar overwrites the user's object in Astro's config merge, so
        // the built-in never runs in parallel with ours.
        updateConfig({ prefetch: false });
        injectScript(
          "page",
          `import { init } from "@tinloof/astro-prefetch/client";\ninit(${JSON.stringify(options)});`
        );
      },
    },
  };
}
