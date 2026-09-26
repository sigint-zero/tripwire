import {
  MAX_KEY_NAME,
  MAX_KEYSTORE_BYTES,
  MIN_PASSPHRASE,
  type KeyDetail,
  type KeyItem,
  type KeyList,
  type KeyPower,
  type KeyTransaction,
  type NewKey,
  type ResponseStatus,
} from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { join } from "node:path";
import { z } from "zod";
import type {
  ActionRow,
  ContractRow,
  EngineCommands,
  EngineReads,
  KeyRow,
  OperatorRow,
  ReadCall,
} from "./engine/types";
import { actsOnChain, DEFAULT_ADMIN_ROLE, hasView } from "./readiness";
import { refuse } from "./refuse";
import { toTx } from "./responses";
import { DASHBOARD, type AppStore } from "./store";

// The keys responses are signed with (`RESPONSES.md`, Keys). The engine
// holds them; a passphrase passes through here to the engine and is
// dropped, never stored, returned or logged. Their names are the
// application's own. For now there is one key: the engine signs with the
// configured key or the only one, and a second key with none configured
// would stop every response.

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
const naming = z.object({
  name: z.string().trim().max(MAX_KEY_NAME).nullable(),
});
const importing = z.object({
  keystore: z.union([z.string(), z.record(z.string(), z.unknown())]),
  passphrase,
});

type ByAddress = { Params: { address: string } };

export const keyRoutes: FastifyPluginCallback<{
  commands: EngineCommands;
  reads: EngineReads;
  store: AppStore;
  /** The signing key named in the configuration, if any. */
  signingKey?: () => string | null;
  /** The installation's response mode now. */
  responseMode?: () => "notify" | "prepare" | "send";
  /** Where the engine keeps its keystore files; null for the stand-in. */
  directory: string | null;
  clock?: () => number;
}> = (
  app,
  {
    commands,
    reads,
    store,
    signingKey = () => null,
    responseMode = () => "notify",
    directory,
    clock = Date.now,
  },
  done,
) => {
  const fileOf = (address: string) =>
    directory ? join(directory, `${address}.json`) : null;
  const attempts = new Map<string, number[]>();
  const noSuchKey = (reply: Parameters<typeof refuse>[0]) =>
    refuse(reply, 404, "not_found", "No such key.");
  /**
   * Refuses a second key while the engine signs with the only one. It
   * answers whether it refused: a reply is thenable, so it is never
   * handed back through an `await`.
   */
  const refusedSecondKey = async (reply: Parameters<typeof refuse>[0]) => {
    const [held] = await commands.keys();
    if (!held) return false;
    refuse(
      reply,
      409,
      "one_key",
      `Tripwire keeps one key for now, and it has ${held.address}.`,
    );
    return true;
  };

  const itemOf = (
    key: KeyRow,
    keys: KeyRow[],
    operators: OperatorRow[],
    names: Map<string, string>,
    onChain: number,
  ): KeyItem => {
    const signing = isSigning(key.address, keys, signingKey());
    return {
      address: key.address,
      name: names.get(key.address.toLowerCase()) ?? null,
      unlocked: key.unlocked,
      balanceWei: key.balance,
      signing,
      // In notify mode the engine builds nothing, so no key is needed.
      neededBy: signing && responseMode() !== "notify" ? onChain : 0,
      operatorOn: operators
        .filter((o) => o.operator === key.address.toLowerCase())
        .map((o) => o.contract_address),
      file: fileOf(key.address),
    };
  };
  const onChainRules = async () =>
    (await reads.rules()).filter(actsOnChain).length;

  app.get("/keys", async (): Promise<KeyList> => {
    const [keys, operators, names, onChain] = await Promise.all([
      commands.keys(),
      reads.operators(),
      store.keyNames(),
      onChainRules(),
    ]);
    return {
      keys: keys.map((key) => itemOf(key, keys, operators, names, onChain)),
      directory,
    };
  });

  app.get<ByAddress>("/keys/:address", async (request, reply) => {
    const address = addressOf(request.params.address);
    if (!address) return noSuchKey(reply);
    const [keys, operators, names, onChain, contracts, responses, actions] =
      await Promise.all([
        commands.keys(),
        reads.operators(),
        store.keyNames(),
        onChainRules(),
        reads.contracts(),
        reads.responses({ statuses: SENT }),
        reads.actions(),
      ]);
    const key = keys.find((k) => k.address === address);
    if (!key) return noSuchKey(reply);

    const { powers, problem } = await powersOf(address, contracts, commands);
    const named = new Map(contracts.map((c) => [c.address.toLowerCase(), c]));
    for (const o of operators) {
      if (o.operator !== address) continue;
      powers.push({
        contract: {
          address: o.contract_address,
          name:
            named.get(o.contract_address.toLowerCase())?.name ??
            o.contract_address,
        },
        power: "operator",
      });
    }

    // The engine signs with one key: the configured one, or the only
    // one. When its transaction does not name the sender, it was the
    // only key's; with several keys, it cannot be told.
    const sole = keys.length === 1 ? keys[0]!.address : null;
    let unattributed = 0;
    const transactions: KeyTransaction[] = [];
    const take = (tx: ReturnType<typeof toTx>, item: () => KeyTransaction) => {
      if (!tx?.hash) return;
      const sender = tx.from?.toLowerCase() ?? sole;
      if (sender === null) unattributed++;
      else if (sender === address) transactions.push(item());
    };
    for (const row of responses) {
      const tx = toTx(row.tx);
      take(tx, () => ({
        kind: "response",
        id: row.id,
        reason: row.rule_name,
        call: tx!.function ?? row.action,
        contract: { address: row.contract_address, name: row.contract_name },
        status: row.status,
        hash: tx!.hash!,
        block: tx!.block,
        gasUsed: tx!.gasUsed,
        createdAt: row.created_at,
      }));
    }
    for (const row of actions) {
      const tx = toTx(row.tx);
      take(tx, () => ({
        kind: "action",
        id: row.id,
        reason: row.note,
        call: actionCall(row),
        contract: {
          address: row.target,
          name: named.get(row.target.toLowerCase())?.name ?? null,
        },
        status: row.status,
        hash: tx!.hash!,
        block: tx!.block,
        gasUsed: tx!.gasUsed,
        createdAt: row.created_at,
      }));
    }
    transactions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      key: itemOf(key, keys, operators, names, onChain),
      powers,
      powersProblem: problem,
      transactions,
      unattributed,
    } satisfies KeyDetail;
  });

  app.put<ByAddress>("/keys/:address/name", async (request, reply) => {
    const address = addressOf(request.params.address);
    if (!address) return noSuchKey(reply);
    const body = naming.safeParse(request.body ?? {});
    if (!body.success) {
      return refuse(
        reply,
        400,
        "invalid_name",
        `A name is at most ${MAX_KEY_NAME} characters.`,
      );
    }
    if (!(await commands.keys()).some((k) => k.address === address)) {
      return noSuchKey(reply);
    }
    const name = body.data.name || null;
    await store.nameKey(address, name, request.account?.id ?? DASHBOARD);
    return { address, name };
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
    if (await refusedSecondKey(reply)) return reply;
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
    if (await refusedSecondKey(reply)) return reply;
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
    if (!address) return noSuchKey(reply);
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
    if (!address) return noSuchKey(reply);
    return commands.lockKey(address);
  });

  done();
};

/** The engine signs with the configured key, or else the only one. */
export function isSigning(
  address: string,
  keys: KeyRow[],
  configured: string | null,
): boolean {
  return configured
    ? configured.toLowerCase() === address.toLowerCase()
    : keys.length === 1;
}

/** Responses whose transaction may have gone out. */
const SENT: ResponseStatus[] = [
  "submitted",
  "confirmed",
  "failed",
  "abandoned",
];

/** An action's call, as a person would name it. */
function actionCall(row: ActionRow): string {
  switch (row.kind) {
    case "trip_global":
      return "pause (controller)";
    case "trip_function":
      return `pause ${row.selector ?? "a function"} (controller)`;
    case "reset_global":
      return "unpause (controller)";
    case "reset_function":
      return `unpause ${row.selector ?? "a function"} (controller)`;
    case "call":
      return row.function ?? "call";
  }
}

/**
 * Whether the key owns, or holds the admin role on, each registered
 * contract that has `owner()` or `hasRole`: read at the current block in
 * one batch through the engine.
 */
async function powersOf(
  address: string,
  contracts: ContractRow[],
  commands: EngineCommands,
): Promise<{ powers: KeyPower[]; problem: string | null }> {
  const asked: { contract: ContractRow; power: "owner" | "admin" }[] = [];
  const calls: ReadCall[] = [];
  for (const contract of contracts) {
    if (hasView(contract.abi, "owner", [])) {
      asked.push({ contract, power: "owner" });
      calls.push({
        address: contract.address,
        function: "owner() returns (address)",
        args: [],
      });
    }
    if (hasView(contract.abi, "hasRole", ["bytes32", "address"])) {
      asked.push({ contract, power: "admin" });
      calls.push({
        address: contract.address,
        function: "hasRole(bytes32,address) returns (bool)",
        args: [DEFAULT_ADMIN_ROLE, address],
      });
    }
  }
  if (calls.length === 0) return { powers: [], problem: null };
  let values: (string | string[] | null)[];
  try {
    values = await commands.read(calls);
  } catch (error) {
    return {
      powers: [],
      problem: `The contracts' owners and roles cannot be read now: ${(error as Error).message}`,
    };
  }
  const powers: KeyPower[] = [];
  asked.forEach(({ contract, power }, i) => {
    const value = values[i];
    const holds =
      power === "owner"
        ? typeof value === "string" && value.toLowerCase() === address
        : value === "true";
    if (holds) {
      powers.push({
        contract: { address: contract.address, name: contract.name },
        power,
      });
    }
  });
  return { powers, problem: null };
}

function addressOf(text: string): string | null {
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null;
}
