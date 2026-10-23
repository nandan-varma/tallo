import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  // No sessions or image transforms: no KV namespace or Images binding to provision.
  adapter: cloudflare({ imageService: "passthrough" }),
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
  session: false,
  security: { checkOrigin: true },
});
