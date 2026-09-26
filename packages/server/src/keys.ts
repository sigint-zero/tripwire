import {
  MAX_KEYSTORE_BYTES,
  MIN_PASSPHRASE,
  type KeyItem,
  type KeyList,
  type NewKey,
} from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { join } from "node:path";
import { z } from "zod";
import type { EngineCommands, EngineReads } from "./engine/types";
import { refuse } from "./refuse";

// The keys responses are signed with (`RESPONSES.md`, Keys). The engine
// holds them; a passphrase passes through here to the engine and is
// dropped, never stored, returned or logged.

/** Unlocking: five attempts per key per minute. */
const ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60_000;

const passphrase = z.string().min(1).max(1024);
const creation = z.object({
  passphrase: passphrase.min(
    MIN_PASSPHRASE,
    `must be at least ${MIN_PASSPHRASE} characters`,
  ),
});
const unlocking = z.object({ passphrase });
const importing = z.object({
  keystore: z.union([z.string(), z.record(z.string(), z.unknown())]),
  passphrase,
});

type ByAddress = { Params: { address: string } };

export const keyRoutes: FastifyPluginCallback<{
  commands: EngineCommands;
  reads: EngineReads;
  /** Where the engine keeps its keystore files; null for the stand-in. */
  directory: string | null;
  clock?: () => number;
}> = (app, { commands, reads, directory, clock = Date.now }, done) => {
  const fileOf = (address: string) =>
    directory ? join(directory, `${address}.json`) : null;
  const attempts = new Map<string, number[]>();

  app.get("/keys", async (): Promise<KeyList> => {
    const [keys, operators] = await Promise.all([
      commands.keys(),
      reads.operators(),
    ]);
    return {
      keys: keys.map((key): KeyItem => ({
        address: key.address,
        unlocked: key.unlocked,
        balanceWei: key.balance,
        // Until a signing key is chosen in the response settings, the
        // only key is the one.
        signing: keys.length === 1,
        operatorOn: operators
          .filter((o) => o.operator === key.address.toLowerCase())
          .map((o) => o.contract_address),
        file: fileOf(key.address),
      })),
      directory,
    };
  });

  app.post("/keys", async (request, reply) => {
    const body = creation.safeParse(request.body ?? {});
    if (!body.success) {
      return refuse(
        reply,
        400,
        "invalid_passphrase",
        `The passphrase must be at least ${MIN_PASSPHRASE} characters.`,
      );
    }
    const { address } = await commands.createKey(body.data.passphrase);
    return reply
      .code(201)
      .send({ address, file: fileOf(address) } satisfies NewKey);
  });

  app.post("/keys/import", async (request, reply) => {
    const body = importing.safeParse(request.body ?? {});
    if (!body.success) {
      return refuse(
        reply,
        400,
        "invalid_request",
        "Send the keystore and its passphrase.",
      );
    }
    const text =
      typeof body.data.keystore === "string"
        ? body.data.keystore
        : JSON.stringify(body.data.keystore);
    if (Buffer.byteLength(text) > MAX_KEYSTORE_BYTES) {
      return refuse(
        reply,
        400,
        "invalid_keystore",
        "A keystore file is a few hundred bytes; this is over 64 KB.",
      );
    }
    let keystore: unknown;
    try {
      keystore =
        typeof body.data.keystore === "string"
          ? JSON.parse(body.data.keystore)
          : body.data.keystore;
    } catch {
      return refuse(reply, 400, "invalid_keystore", "The file is not JSON.");
    }
    if (typeof keystore !== "object" || keystore === null) {
      return refuse(
        reply,
        400,
        "invalid_keystore",
        "The file is not a keystore.",
      );
    }
    // The engine would replace a key it already has; most keystores name
    // their address, so that is refused before anything is decrypted.
    const named = (keystore as { address?: unknown }).address;
    if (typeof named === "string") {
      const address = `0x${named.replace(/^0x/i, "").toLowerCase()}`;
      if ((await commands.keys()).some((k) => k.address === address)) {
        return refuse(
          reply,
          409,
          "key_exists",
          `Tripwire already has the key ${address}.`,
        );
      }
    }
    const { address } = await commands.importKey(
      keystore,
      body.data.passphrase,
    );
    return reply
      .code(201)
      .send({ address, file: fileOf(address) } satisfies NewKey);
  });

  app.post<ByAddress>("/keys/:address/unlock", async (request, reply) => {
    const address = addressOf(request.params.address);
    if (!address) return refuse(reply, 404, "not_found", "No such key.");
    const body = unlocking.safeParse(request.body ?? {});
    if (!body.success) {
      return refuse(reply, 400, "invalid_request", "Send the passphrase.");
    }
    const now = clock();
    const recent = (attempts.get(address) ?? []).filter(
      (at) => now - at < ATTEMPT_WINDOW_MS,
    );
    if (recent.length >= ATTEMPTS) {
      attempts.set(address, recent);
      return refuse(
        reply,
        429,
        "too_many_attempts",
        "Five tries in a minute. Wait a minute and try again.",
      );
    }
    attempts.set(address, [...recent, now]);
    return commands.unlockKey(address, body.data.passphrase);
  });

  app.post<ByAddress>("/keys/:address/lock", async (request, reply) => {
    const address = addressOf(request.params.address);
    if (!address) return refuse(reply, 404, "not_found", "No such key.");
    return commands.lockKey(address);
  });

  done();
};

function addressOf(text: string): string | null {
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null;
}
