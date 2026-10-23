import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  // No sessions or image transforms: no KV namespace or Images binding to provision.
  adapter: cloudflare({ imageService: "passthrough" }),
  session: false,
  security: { checkOrigin: true },
});
