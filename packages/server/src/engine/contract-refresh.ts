import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listedDigest, verifyMinisign, type EnginePin } from "./release";

// Refreshes fixtures/contract, the engine contract the parity tests read,
// whenever the pin moves:
//
//   pnpm --filter @tripwire/server contract:refresh            # the pinned release
//   pnpm --filter @tripwire/server contract:refresh <checkout> # an engine checkout
//
// A release is checked exactly as an install is: SHA256SUMS against the
// pinned minisign key, every file against SHA256SUMS.

const FIXTURES = fileURLToPath(
  new URL("./fixtures/contract/", import.meta.url),
);
const PIN = fileURLToPath(new URL("../../../cli/engine.json", import.meta.url));
const FILES = ["rule.schema.json", "views.json", "openapi.json"];

async function fromCheckout(checkout: string) {
  await reset();
  for (const file of FILES) {
    await cp(join(checkout, "contract", file), join(FIXTURES, file));
  }
  await cp(
    join(checkout, "crates/rules/tests/corpus/valid"),
    join(FIXTURES, "rule-examples"),
    { recursive: true },
  );
  await writeFile(join(FIXTURES, "VERSION"), "checkout\n");
  console.log(`Contract copied from ${checkout}; VERSION says checkout.`);
}

async function fromRelease() {
  const pin = JSON.parse(await readFile(PIN, "utf8")) as EnginePin;
  const url = (asset: string) =>
    pin.releases.replace("{version}", pin.version).replace("{asset}", asset);
  const fetchBytes = async (asset: string) => {
    const response = await fetch(url(asset));
    if (!response.ok) throw new Error(`${asset}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const sums = await fetchBytes("SHA256SUMS");
  verifyMinisign(
    sums,
    (await fetchBytes("SHA256SUMS.minisig")).toString("utf8"),
    pin.publicKey,
  );
  const checked = async (asset: string) => {
    const bytes = await fetchBytes(asset);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== listedDigest(sums.toString("utf8"), asset)) {
      throw new Error(`${asset}: does not match SHA256SUMS`);
    }
    return bytes;
  };
  await reset();
  for (const file of FILES) {
    await writeFile(join(FIXTURES, file), await checked(file));
  }
  const work = await mkdtemp(join(tmpdir(), "tripwire-contract-"));
  try {
    const archive = join(work, "rule-examples.tar.gz");
    await writeFile(archive, await checked("rule-examples.tar.gz"));
    await mkdir(join(FIXTURES, "rule-examples"));
    execFileSync("tar", [
      "-xzf",
      archive,
      "-C",
      join(FIXTURES, "rule-examples"),
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await writeFile(join(FIXTURES, "VERSION"), `${pin.version}\n`);
  const examples = await readdir(join(FIXTURES, "rule-examples"));
  console.log(
    `Contract of engine ${pin.version} verified and written (${examples.length} examples).`,
  );
}

async function reset() {
  await rm(FIXTURES, { recursive: true, force: true });
  await mkdir(FIXTURES, { recursive: true });
}

const checkout = process.argv[2];
await (checkout ? fromCheckout(checkout) : fromRelease());
