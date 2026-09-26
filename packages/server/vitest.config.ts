import { defineConfig } from "vitest/config";

// Many tests start a PGlite database, which takes a few seconds, and more
// when test files start theirs in parallel.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
