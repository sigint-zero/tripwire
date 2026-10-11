import type { ListView } from "../lib/view";
import { choice, track } from "./ui";

const views: { view: ListView; title: string; icon: string }[] = [
  { view: "rows", title: "Rows", icon: "M2 3.5h12M2 8h12M2 12.5h12" },
  {
    view: "cards",
    title: "Cards",
    icon: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  },
];

/** The Rows and Cards switch beside a list. */
export function ViewToggle({
  value,
  onChange,
}: {
  value: ListView;
  onChange: (view: ListView) => void;
}) {
  return (
    <div className={track} role="group" aria-label="Layout">
      {views.map((v) => (
        <button
          key={v.view}
          type="button"
          aria-pressed={value === v.view}
          title={v.view === "rows" ? "One rule per row" : "Rules as cards"}
          onClick={() => onChange(v.view)}
          className={choice(value === v.view)}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            className="size-3.5 shrink-0"
          >
            <path d={v.icon} />
          </svg>
          {v.title}
        </button>
      ))}
    </div>
  );
}
