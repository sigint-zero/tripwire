import type { ContractSurface } from "../../lib/abi";
import { formatBig } from "../../lib/format";
import {
  compareOps,
  durations,
  NUMBER_PREFIX,
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
      return (
        durations.find((d) => String(d.seconds) === value)?.label ?? `${value}s`
      );
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
          inputMode="numeric"
          value={value}
          onChange={(e) =>
            onChange(e.target.value.replace(/\D/g, "").slice(0, 3))
          }
        />
      );
    case "duration":
      return (
        <select
          {...aria}
          className={blank}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {durations.map((d) => (
            <option key={d.seconds} value={d.seconds}>
              {d.label}
            </option>
          ))}
        </select>
      );
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
