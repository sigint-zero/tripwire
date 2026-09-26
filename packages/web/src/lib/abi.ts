import { toFunctionSelector } from "viem";

// Picks out of an ABI what the wizard can offer: numbers it can read, events
// it can watch, and functions it can pause.

interface AbiParam {
  name?: string;
  type: string;
  components?: AbiParam[];
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
  /** Encodes the function and return index, e.g. "latestRoundData()#3". */
  id: string;
  method: string;
  returnIndex: number;
  label: string;
}

export interface ContractEvent {
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

function canonicalType(param: AbiParam): string {
  if (!param.type.startsWith("tuple")) return param.type;
  const inner = (param.components ?? []).map(canonicalType).join(",");
  return `(${inner})${param.type.slice("tuple".length)}`;
}

function signature(entry: AbiEntry): string {
  return `${entry.name}(${(entry.inputs ?? []).map(canonicalType).join(",")})`;
}

export function readableId(method: string, returnIndex: number): string {
  return `${method}#${returnIndex}`;
}

export function parseReadableId(id: string): {
  method: string;
  returnIndex: number;
} {
  const [method = "", index = "0"] = id.split("#");
  return { method, returnIndex: Number(index) };
}

export function describeAbi(abi: unknown[]): ContractSurface {
  const surface: ContractSurface = { reads: [], events: [], writes: [] };
  for (const raw of abi) {
    const entry = raw as AbiEntry;
    if (!entry.name) continue;
    if (entry.type === "event") {
      surface.events.push({ signature: signature(entry), name: entry.name });
    }
    if (entry.type !== "function") continue;
    const view =
      entry.stateMutability === "view" || entry.stateMutability === "pure";
    if (!view) {
      const sig = signature(entry);
      surface.writes.push({
        signature: sig,
        selector: toFunctionSelector(sig),
      });
      continue;
    }
    if ((entry.inputs ?? []).length > 0) continue;
    const outputs = entry.outputs ?? [];
    outputs.forEach((output, index) => {
      if (!/^u?int\d*$/.test(output.type)) return;
      const method = `${entry.name}()`;
      surface.reads.push({
        id: readableId(method, index),
        method,
        returnIndex: index,
        label:
          outputs.length > 1
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
