import { isSupportedAbiType } from "@tripwire/shared";
import {
  encodeFunctionData,
  parseAbiItem,
  toFunctionSelector,
  type AbiFunction,
} from "viem";

// Picks out of an ABI what the wizard can offer: numbers it can read, events
// it can watch, and functions a trip can pause or call. Anything with an
// array or tuple parameter or return is left out, because rules cannot
// reference it.

interface AbiParam {
  name?: string;
  type: string;
  indexed?: boolean;
}

interface AbiEntry {
  type?: string;
  name?: string;
  stateMutability?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
}

/** A number the contract exposes through a view function with no arguments. */
export interface Readable {
  /** The read, with the output's index when it returns several: "getReserves() returns (…)#2". */
  id: string;
  /** Declares what it returns, as rules name reads: "totalSupply() returns (uint256)". */
  method: string;
  /** Which output, for a function that returns several; rules must name it. */
  returns?: number;
  label: string;
}

export interface ContractEvent {
  /** Declaration style, as rules name events: "Paused(address account)". */
  signature: string;
  name: string;
}

export interface WriteFunction {
  signature: string;
  selector: string;
  /** Its parameters, for giving a call its arguments. */
  inputs: { name: string; type: string }[];
}

export interface ContractSurface {
  reads: Readable[];
  /** True-or-false reads, offered only to confirm a call took effect. */
  flags: Readable[];
  events: ContractEvent[];
  writes: WriteFunction[];
}

/** "transfer(address,uint256)", or null when a parameter cannot be named in a rule. */
function positional(entry: AbiEntry): string | null {
  const inputs = entry.inputs ?? [];
  if (!inputs.every((p) => isSupportedAbiType(p.type))) return null;
  return `${entry.name}(${inputs.map((p) => p.type).join(",")})`;
}

/** "Transfer(address indexed from, uint256 value)"; rules need every parameter named. */
function declaration(entry: AbiEntry): string | null {
  const inputs = entry.inputs ?? [];
  if (!inputs.every((p) => p.name && isSupportedAbiType(p.type))) return null;
  const params = inputs.map(
    (p) => `${p.type}${p.indexed ? " indexed" : ""} ${p.name}`,
  );
  return `${entry.name}(${params.join(", ")})`;
}

export function readableId(method: string, returns?: number): string {
  return returns === undefined ? method : `${method}#${returns}`;
}

export function parseReadableId(id: string): {
  method: string;
  returns?: number;
} {
  const [method = "", index] = id.split("#");
  return index === undefined ? { method } : { method, returns: Number(index) };
}

export function describeAbi(abi: unknown[]): ContractSurface {
  const surface: ContractSurface = {
    reads: [],
    flags: [],
    events: [],
    writes: [],
  };
  for (const raw of abi) {
    const entry = raw as AbiEntry;
    if (!entry.name) continue;
    if (entry.type === "event") {
      const signature = declaration(entry);
      if (signature) surface.events.push({ signature, name: entry.name });
    }
    if (entry.type !== "function") continue;
    const view =
      entry.stateMutability === "view" || entry.stateMutability === "pure";
    if (!view) {
      const signature = positional(entry);
      if (signature) {
        surface.writes.push({
          signature,
          selector: toFunctionSelector(signature),
          inputs: (entry.inputs ?? []).map((p) => ({
            name: p.name ?? "",
            type: p.type,
          })),
        });
      }
      continue;
    }
    if ((entry.inputs ?? []).length > 0) continue;
    const outputs = entry.outputs ?? [];
    // A read declares everything it returns, so every output must be one
    // rules can describe.
    if (!outputs.length || !outputs.every((o) => isSupportedAbiType(o.type))) {
      continue;
    }
    const several = outputs.length > 1;
    const method = `${entry.name}() returns (${outputs.map((o) => o.type).join(",")})`;
    outputs.forEach((output, index) => {
      const list = /^u?int\d*$/.test(output.type)
        ? surface.reads
        : output.type === "bool"
          ? surface.flags
          : null;
      if (!list) return;
      const returns = several ? index : undefined;
      list.push({
        id: readableId(method, returns),
        method,
        ...(several ? { returns: index } : {}),
        label: several ? `${entry.name}.${output.name || index}` : entry.name!,
      });
    });
  }
  const byLabel = (a: { signature?: string; label?: string }, b: typeof a) =>
    (a.label ?? a.signature ?? "").localeCompare(b.label ?? b.signature ?? "");
  surface.reads.sort(byLabel);
  surface.flags.sort(byLabel);
  surface.events.sort(byLabel);
  surface.writes.sort(byLabel);
  return surface;
}

/** Accepts a bare ABI array or an artifact with an `abi` field. */
export function parseAbiText(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  const abi = Array.isArray(parsed)
    ? parsed
    : (parsed as { abi?: unknown } | null)?.abi;
  if (!Array.isArray(abi)) {
    throw new Error("Expected a JSON array, or an object with an abi field.");
  }
  return abi as unknown[];
}

/** An argument as the ABI encoder takes it, from the text a person typed. */
function argument(type: string, text: string): unknown {
  if (/^u?int\d*$/.test(type)) return BigInt(text);
  if (type === "bool") {
    if (text !== "true" && text !== "false") throw new Error("true or false");
    return text === "true";
  }
  return text;
}

/**
 * The calldata for a call to `signature` with the arguments a person
 * typed, as the engine encodes a call: for sending the same call from a
 * wallet. Throws with the reason when the arguments do not fit.
 */
export function encodeCall(signature: string, args: string[]): string {
  const item = parseAbiItem(`function ${signature}`) as AbiFunction;
  return encodeFunctionData({
    abi: [item],
    args: item.inputs.map((input, i) => argument(input.type, args[i] ?? "")),
  });
}
