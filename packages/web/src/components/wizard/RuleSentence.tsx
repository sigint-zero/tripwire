import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ContractSurface } from "../../lib/abi";
import { api } from "../../lib/api";
import {
  blockSeconds,
  durationProblem,
  fromSeconds,
  humanDuration,
  toSeconds,
  type Unit,
} from "../../lib/duration";
import { formatBig } from "../../lib/format";
import {
  compareOps,
  NUMBER_PREFIX,
  percentTyped,
  type Field,
  type Template,
  type Values,
} from "../../lib/templates";

const blank =
  "mx-1 inline-block field-sizing-content appearance-none border-b-2 border-dashed border-emerald-500/70 bg-emerald-500/10 px-2 py-0.5 align-baseline font-mono text-[0.8em] text-emerald-300 transition-colors hover:bg-emerald-500/20 focus:border-solid focus:outline-none";

/** How a filled-in blank reads in a sentence. */
export function blankLabel(
  field: Field,
  value: string | undefined,
  surface: ContractSurface,
): string {
  if (!value) return `‹${field.label}›`;
  switch (field.kind) {
    case "read":
    case "readOrNumber":
      if (value.startsWith(NUMBER_PREFIX)) {
        const digits = value.slice(NUMBER_PREFIX.length);
        return /^\d+$/.test(digits) ? formatBig(digits) : "…";
      }
      return surface.reads.find((r) => r.id === value)?.label ?? value;
    case "event":
      return value.replace(/\(.*$/, "");
    case "duration":
      return /^\d+$/.test(value) ? humanDuration(Number(value)) : "…";
    case "op":
      return compareOps.find((o) => o.op === value)?.label ?? value;
    case "percent":
      return value;
  }
}

export function sentenceText(
  template: Template,
  values: Values,
  surface: ContractSurface,
): string {
  return template.sentence
    .map((part) => {
      if (typeof part === "string") return part;
      const field = template.fields.find((f) => f.key === part.field);
      return field ? blankLabel(field, values[part.field], surface) : "";
    })
    .join("");
}

export function RuleSentence({
  template,
  values,
  surface,
  onChange,
}: {
  template: Template;
  values: Values;
  surface: ContractSurface;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <p className="font-display text-3xl leading-[1.9] font-bold tracking-tight text-white md:text-4xl">
      {template.sentence.map((part, i) => {
        if (typeof part === "string") return <span key={i}>{part}</span>;
        const field = template.fields.find((f) => f.key === part.field);
        if (!field) return null;
        const value = values[field.key];
        return (
          <Blank
            key={i}
            field={field}
            value={value ?? ""}
            surface={surface}
            onChange={(next) => onChange(field.key, next)}
          />
        );
      })}
    </p>
  );
}

function Blank({
  field,
  value,
  surface,
  onChange,
}: {
  field: Field;
  value: string;
  surface: ContractSurface;
  onChange: (value: string) => void;
}) {
  const aria = { "aria-label": field.label };
  switch (field.kind) {
    case "percent":
      return (
        <input
          {...aria}
          className={`${blank} min-w-[2ch] text-center`}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(percentTyped(e.target.value))}
        />
      );
    case "duration":
      return <DurationBlank field={field} value={value} onChange={onChange} />;
    case "op":
      return (
        <select
          {...aria}
          className={blank}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {compareOps.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "event":
      return (
        <select
          {...aria}
          className={blank}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {!value && (
            <option value="" disabled>
              choose {field.label}…
            </option>
          )}
          {surface.events.map((e) => (
            <option key={e.signature} value={e.signature}>
              {e.name}
            </option>
          ))}
        </select>
      );
    case "read":
    case "readOrNumber": {
      // A typed number replaces the dropdown; a small switch goes back.
      if (value.startsWith(NUMBER_PREFIX)) {
        return (
          <span className="inline-flex items-baseline">
            <input
              aria-label={`${field.label} number`}
              className={`${blank} mr-0 min-w-[2ch] tabular-nums`}
              inputMode="numeric"
              placeholder="0"
              value={value.slice(NUMBER_PREFIX.length)}
              onChange={(e) =>
                onChange(`${NUMBER_PREFIX}${e.target.value.replace(/\D/g, "")}`)
              }
            />
            <button
              type="button"
              title="Compare with a value from the contract instead"
              aria-label={`Use a contract value for ${field.label}`}
              onClick={() => onChange(surface.reads[0]?.id ?? "")}
              className="ml-1 self-center font-mono text-xs text-gray-600 transition-colors hover:text-emerald-400"
            >
              ⇄
            </button>
          </span>
        );
      }
      return (
        <select
          {...aria}
          className={blank}
          value={value}
          onChange={(e) =>
            onChange(
              e.target.value === NUMBER_PREFIX ? NUMBER_PREFIX : e.target.value,
            )
          }
        >
          {!value && (
            <option value="" disabled>
              choose {field.label}…
            </option>
          )}
          {surface.reads.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
          {field.kind === "readOrNumber" && (
            <option value={NUMBER_PREFIX}>a fixed number…</option>
          )}
        </select>
      );
    }
  }
}

const invalid = "border-red-400/80! bg-red-500/10! text-red-300!";
const units: Unit[] = ["blocks", "seconds", "minutes", "hours", "days"];

interface Entry {
  amount: string;
  unit: Unit;
}

function entryFor(value: string): Entry {
  if (!/^\d+$/.test(value)) return { amount: "", unit: "minutes" };
  const { amount, unit } = fromSeconds(Number(value));
  return { amount: String(amount), unit };
}

/**
 * A number and a unit, from blocks to days. The rule keeps seconds; blocks
 * convert with the chain's block time.
 */
function DurationBlank({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: string;
  onChange: (value: string) => void;
}) {
  const { data: engine } = useQuery({
    queryKey: ["engine"],
    queryFn: ({ signal }) => api.engine(signal),
    staleTime: Infinity,
  });
  const perBlock = blockSeconds(engine?.chainId);
  const [entry, setEntry] = useState(() => entryFor(value));
  const secondsOf = (e: Entry) =>
    e.amount === "" ? null : toSeconds(Number(e.amount), e.unit, perBlock);
  const emitted = (e: Entry) => String(secondsOf(e) ?? "");

  // Follow a value set from elsewhere, such as another starting point.
  if (
    /^\d*$/.test(value) &&
    value !== emitted(entry) &&
    !(entry.unit === "blocks" && !perBlock)
  ) {
    setEntry(entryFor(value));
  }

  const update = (next: Entry) => {
    setEntry(next);
    onChange(emitted(next));
  };
  const seconds = secondsOf(entry);
  const problem = entry.amount === "" ? null : durationProblem(seconds);
  const one = entry.amount === "1";

  return (
    <span className="inline-flex items-baseline" title={problem ?? undefined}>
      <input
        aria-label={`${field.label} amount`}
        className={`${blank} mr-0 min-w-[2ch] text-center tabular-nums ${problem ? invalid : ""}`}
        inputMode="numeric"
        placeholder="0"
        value={entry.amount}
        onChange={(e) =>
          update({
            ...entry,
            amount: e.target.value.replace(/\D/g, "").slice(0, 7),
          })
        }
      />
      <select
        aria-label={`${field.label} unit`}
        className={`${blank} ${problem ? invalid : ""}`}
        value={entry.unit}
        onChange={(e) => update({ ...entry, unit: e.target.value as Unit })}
      >
        {units
          .filter((u) => u !== "blocks" || perBlock || entry.unit === "blocks")
          .map((u) => (
            <option key={u} value={u}>
              {one ? u.slice(0, -1) : u}
            </option>
          ))}
      </select>
      {entry.unit === "blocks" && seconds !== null && !problem && (
        <span className="ml-1 font-mono text-sm font-normal tracking-normal text-gray-500">
          ≈ {humanDuration(seconds)}
        </span>
      )}
    </span>
  );
}
