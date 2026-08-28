import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    // The dev server is sometimes started from the repository root rather than
    // from here. Without deduping, that can resolve two copies of React - the
    // symptom is "Invalid hook call" on every component at once.
    dedupe: ["react", "react-dom"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
    outDir: path.join(here, "dist"),
    emptyOutDir: true,
  },
});
