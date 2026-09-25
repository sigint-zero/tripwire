// Bundles the command line and server into one file, with the built
// dashboard alongside it, so the package installs with no dependencies.
import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/tripwire.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Bundled CommonJS dependencies call require(); ESM output has none.
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

await cp("../web/dist", "dist/web", { recursive: true });
