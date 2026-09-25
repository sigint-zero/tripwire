// Bundles the command line and server into one file, with the built
// dashboard alongside it, so the package installs with no dependencies.
import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Resolve from this file, not the working directory, so the build is safe
// to run from anywhere.
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

await rm(here("./dist"), { recursive: true, force: true });

await build({
  entryPoints: [here("./src/main.ts")],
  outfile: here("./dist/tripwire.mjs"),
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

await cp(here("../web/dist"), here("./dist/web"), { recursive: true });
