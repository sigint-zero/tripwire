// Bundles the command line and server into one file, with the built
// dashboard alongside it, so the package installs with no dependencies.
import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
// The MCP server's teaching content, read by the server at start.
await cp(here("../mcp/content"), here("./dist/mcp"), { recursive: true });
// The app schema's migrations, read by the server at start.
await cp(here("../server/migrations"), here("./dist/migrations"), {
  recursive: true,
});
// PGlite loads its WebAssembly and data files from beside its own code,
// which after bundling is the executable.
const pglite = dirname(
  createRequire(here("../server/package.json")).resolve("@electric-sql/pglite"),
);
for (const file of ["pglite.wasm", "pglite.data", "initdb.wasm"]) {
  await cp(join(pglite, file), here(`./dist/${file}`));
}
