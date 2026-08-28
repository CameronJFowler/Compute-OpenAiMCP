import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved against this file rather than the working directory: the dev server
// is sometimes started from the repository root, and cwd-relative globs
// silently match nothing when it is.
const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("tailwindcss").Config} */
export default {
  content: [path.join(here, "index.html"), path.join(here, "src/**/*.{ts,tsx}")],
  theme: {
    extend: {
      fontFamily: {
        // No webfonts. The page makes no third-party network requests at all,
        // and that is a claim worth more than a typeface.
        sans: [
          "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI",
          "Inter", "Helvetica Neue", "Arial", "sans-serif",
        ],
        mono: [
          "ui-monospace", "SFMono-Regular", "Menlo", "Consolas",
          "Liberation Mono", "monospace",
        ],
      },
      colors: {
        // Flat, muted, instrument-like. Nothing saturated, no gradients.
        canvas: "#0a0c0f",
        panel: "#101318",
        raised: "#161a20",
        hair: "#1f242b",
        hair2: "#2b323b",
        ink: "#e4e9ef",
        ink2: "#9aa4b1",
        ink3: "#67707c",
        accent: "#d9a441",
        pos: "#5aa87f",
        neg: "#c97b74",
        info: "#5f93c0",
      },
      fontSize: {
        "2xs": ["10px", "14px"],
      },
      letterSpacing: {
        label: "0.11em",
      },
    },
  },
  plugins: [],
};
