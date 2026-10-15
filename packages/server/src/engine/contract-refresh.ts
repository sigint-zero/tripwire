import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CONTRACT_FILES,
  CONTRACT_FIXTURES,
  readPin,
  verifyContractFiles,
} from "./contract-files";

// Rewrites fixtures/contract from the pinned release whenever the pin
// moves:
//
//   pnpm --filter @tripwire/server contract:refresh
//
// Everything is downloaded beside the fixtures and verified, as the
// parity test verifies it, before the old fixtures are replaced: a failed
// or tampered download leaves them as they were.

const pin = await readPin();
const url = (asset: string) =>
  pin.releases.replace("{version}", pin.version).replace("{asset}", asset);

const staging = await mkdtemp(
  join(dirname(CONTRACT_FIXTURES.replace(/\/$/, "")), ".contract-"),
);
try {
  for (const asset of ["SHA256SUMS", "SHA256SUMS.minisig", ...CONTRACT_FILES]) {
    const response = await fetch(url(asset));
    if (!response.ok) throw new Error(`${asset}: HTTP ${response.status}`);
    await writeFile(
      join(staging, asset),
      Buffer.from(await response.arrayBuffer()),
    );
  }
  await verifyContractFiles(staging, pin);
  // Siblings on one filesystem, so both renames are atomic.
  const old = `${CONTRACT_FIXTURES.replace(/\/$/, "")}.old-${process.pid}`;
  await rename(CONTRACT_FIXTURES, old);
  await rename(staging, CONTRACT_FIXTURES);
  await rm(old, { recursive: true, force: true });
  console.log(`Contract of engine ${pin.version} verified and written.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
