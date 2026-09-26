import type { ReactNode } from "react";
import type { ContractSurface } from "../../lib/abi";
import { templates } from "../../lib/templates";

const line = "fill-none stroke-current stroke-2";
const limit =
  "fill-none stroke-current stroke-1 opacity-50 [stroke-dasharray:3_3]";

const glyphs: Record<string, ReactNode> = {
  floor: (
    <>
      <path className={line} d="M2 14 L14 10 L24 18 L36 8 L46 16 L58 12" />
      <path className={limit} d="M2 30 H62" />
    </>
  ),
  band: (
    <>
      <path className={limit} d="M2 8 H62 M2 30 H62" />
      <path
        className={line}
        d="M2 20 L10 16 L18 22 L28 17 L38 21 L48 15 L62 19"
      />
    </>
  ),
  growth: (
    <>
      <path className={limit} d="M2 8 H62" />
      <path
        className="fill-current opacity-80"
        d="M6 28h6v6H6zM18 24h6v10h-6zM30 18h6v16h-6zM42 12h6v22h-6z"
      />
    </>
  ),
  outflow: (
    <>
      <path className={limit} d="M2 26 H62" />
      <path className={line} d="M2 6 L16 8 L28 7 L38 14 L48 22 L58 30" />
    </>
  ),
  fresh: (
    <>
      <circle className={line} cx="32" cy="19" r="14" />
      <path className={line} d="M32 11 V19 L38 23" />
    </>
  ),
  event: (
    <>
      <path className={line} d="M34 4 L22 21 H32 L28 34 L42 16 H32 Z" />
      <path className="fill-none stroke-red-500 stroke-2" d="M14 34 L50 4" />
    </>
  ),
  compare: (
    <path className={line} d="M18 10 L30 16 L18 22 M36 26 H48 M36 30 H48" />
  ),
};

export function TemplateGallery({
  surface,
  selected,
  onSelect,
}: {
  surface: ContractSurface;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {templates.map((template) => {
        const available =
          template.needs === "reads"
            ? surface.reads.length > 0
            : surface.events.length > 0;
        const active = template.id === selected;
        return (
          <button
            key={template.id}
            type="button"
            disabled={!available}
            onClick={() => onSelect(template.id)}
            aria-pressed={active}
            className={`group relative flex flex-col gap-3 border p-5 text-left transition-colors disabled:opacity-30 ${
              active
                ? "border-emerald-500/60 bg-emerald-500/10"
                : "border-white/5 bg-canvas hover:border-emerald-500/30"
            }`}
          >
            <svg
              viewBox="0 0 64 38"
              aria-hidden
              className={`h-10 w-16 ${active ? "text-emerald-400" : "text-emerald-600 group-hover:text-emerald-400"}`}
            >
              {glyphs[template.id]}
            </svg>
            <span className="text-sm font-bold tracking-wider text-white uppercase">
              {template.title}
            </span>
            <span className="text-xs leading-relaxed text-gray-500">
              {available
                ? template.blurb
                : `This contract has no ${template.needs === "reads" ? "readable values" : "events"}.`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
