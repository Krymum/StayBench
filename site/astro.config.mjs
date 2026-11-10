import { defineConfig } from "astro/config";

// Published on GitHub Pages at https://<owner>.github.io/StayBench/.
// Override with SITE_URL / BASE_PATH (e.g. BASE_PATH=/ for a custom domain).
export default defineConfig({
  site: process.env.SITE_URL || "https://krymum.github.io",
  base: process.env.BASE_PATH || "/StayBench",
  trailingSlash: "ignore",
  output: "static",
});
