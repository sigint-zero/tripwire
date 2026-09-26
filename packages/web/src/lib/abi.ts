import { isSupportedAbiType } from "@tripwire/shared";
import { toFunctionSelector } from "viem";

// Picks out of an ABI what the wizard can offer: numbers it can read, events
// it can watch, and functions it can pause. Anything with an array or tuple
// parameter is left out, because rules cannot reference it.

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
  /** The function, with the output's index when it returns several: "latestRoundData()#3". */
  id: string;
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
}

export interface ContractSurface {
  reads: Readable[];
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
  const surface: ContractSurface = { reads: [], events: [], writes: [] };
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
        });
      }
      continue;
    }
    if ((entry.inputs ?? []).length > 0) continue;
    const outputs = entry.outputs ?? [];
    const several = outputs.length > 1;
    outputs.forEach((output, index) => {
      if (!/^u?int\d*$/.test(output.type)) return;
      const method = `${entry.name}()`;
      const returns = several ? index : undefined;
      surface.reads.push({
        id: readableId(method, returns),
        method,
        ...(several ? { returns: index } : {}),
        label: several
          ? `${entry.name}.${output.name || index}`
          : (entry.name ?? method),
      });
    });
  }
  const byLabel = (a: { signature?: string; label?: string }, b: typeof a) =>
    (a.label ?? a.signature ?? "").localeCompare(b.label ?? b.signature ?? "");
  surface.reads.sort(byLabel);
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
