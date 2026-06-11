// @ts-check
import cloudflare from "@astrojs/cloudflare";
import prefetch from "@tinloof/astro-prefetch";
import { defineConfig } from "astro/config";

export default defineConfig({
  // Server output: per-request timestamps on every page expose whether a
  // navigation was served from the prefetch cache or rendered fresh.
  output: "server",
  adapter: cloudflare(),
  integrations: [
    prefetch({
      // Build-time defaults; the control panel live-overrides everything
      // via configure() from @tinloof/astro-prefetch/client.
      debug: true,
    }),
  ],
});
