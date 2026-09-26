import { address, chainName, type ContractAbi } from "@tripwire/shared";
import type {
  FastifyBaseLogger,
  FastifyPluginCallback,
  FastifyReply,
} from "fastify";

// Looks up verified ABIs on Sourcify, which needs no API key. A proxy's
// implementation ABI is merged in, so its functions show up too.

const SOURCIFY = "https://sourcify.dev/server/v2/contract";

interface SourcifyContract {
  match: string | null;
  abi?: unknown[];
  compilation?: { name?: string };
  proxyResolution?: {
    isProxy: boolean;
    implementations: { address: string; name?: string }[];
  };
}

export class AbiNotFound extends Error {}

async function fetchContract(
  chainId: number,
  contract: string,
): Promise<SourcifyContract | null> {
  const url = `${SOURCIFY}/${chainId}/${contract}?fields=abi,compilation.name,proxyResolution`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sourcify answered ${res.status}`);
  const body = (await res.json()) as SourcifyContract;
  return body.match ? body : null;
}

function entryKey(entry: unknown): string {
  const { type, name, inputs } = entry as {
    type?: string;
    name?: string;
    inputs?: { type?: string }[];
  };
  return `${type}:${name}(${(inputs ?? []).map((i) => i.type).join(",")})`;
}

export async function lookupAbi(
  chainId: number,
  contract: string,
): Promise<ContractAbi> {
  const found = await fetchContract(chainId, contract);
  if (!found?.abi) {
    throw new AbiNotFound(
      `No verified contract at this address on ${chainName(chainId)}.`,
    );
  }
  const implementation = found.proxyResolution?.isProxy
    ? found.proxyResolution.implementations[0]
    : undefined;

  const entries = new Map(found.abi.map((e) => [entryKey(e), e]));
  let implementationName: string | null = implementation?.name ?? null;
  if (implementation) {
    const impl = await fetchContract(chainId, implementation.address);
    for (const e of impl?.abi ?? []) entries.set(entryKey(e), e);
    implementationName ??= impl?.compilation?.name ?? null;
  }

  return {
    chainId,
    address: contract,
    name: implementationName ?? found.compilation?.name ?? null,
    abi: [...entries.values()],
    implementation: implementation
      ? { address: implementation.address, name: implementationName }
      : null,
  };
}

/** Looks up verified ABIs on the engine's chain, remembering each answer. */
export class AbiLookup {
  #cache = new Map<string, ContractAbi>();

  constructor(readonly chainId: number) {}

  async get(contract: string): Promise<ContractAbi> {
    const key = contract.toLowerCase();
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const result = await lookupAbi(this.chainId, contract);
    this.#cache.set(key, result);
    return result;
  }
}

/** Sends a failed lookup as the API's error envelope. */
export function lookupFailed(
  reply: FastifyReply,
  log: FastifyBaseLogger,
  error: unknown,
) {
  if (error instanceof AbiNotFound) {
    return reply.code(404).send({
      statusCode: 404,
      error: "Not Found",
      code: "not_verified",
      message: error.message,
    });
  }
  log.warn(error);
  return reply.code(502).send({
    statusCode: 502,
    error: "Bad Gateway",
    code: "lookup_failed",
    message: "Could not reach Sourcify. Paste the ABI instead.",
  });
}

export const abiRoutes: FastifyPluginCallback<{ lookup: AbiLookup }> = (
  app,
  { lookup },
  done,
) => {
  app.get<{ Params: { address: string } }>(
    "/contracts/:address/abi",
    async (request, reply) => {
      const contract = address.safeParse(request.params.address);
      if (!contract.success) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          code: "invalid_contract",
          message: "Invalid address.",
        });
      }
      try {
        return await lookup.get(contract.data);
      } catch (error) {
        return lookupFailed(reply, request.log, error);
      }
    },
  );
  done();
};
