/** Section markers for the rule wizard: where you are, what is done. */
export function Stepper({
  steps,
  active,
  done,
  unlocked,
  onSelect,
}: {
  steps: string[];
  active: number;
  done: boolean[];
  unlocked: boolean[];
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="flex items-center">
      {steps.map((title, i) => {
        const isActive = i === active;
        const isDone = !!done[i] && !isActive;
        return (
          <li key={title} className="flex flex-1 items-center last:flex-none">
            <button
              type="button"
              disabled={!unlocked[i]}
              onClick={() => onSelect(i)}
              aria-current={isActive ? "step" : undefined}
              className="group flex items-center gap-3 disabled:cursor-not-allowed"
            >
              <span
                className={`flex size-8 shrink-0 items-center justify-center border font-mono text-xs font-bold transition-colors ${
                  isActive
                    ? "border-emerald-400 bg-emerald-500/10 text-emerald-400 shadow-[0_0_16px_rgba(16,185,129,0.35)]"
                    : isDone
                      ? "border-emerald-500 bg-emerald-500 text-black group-hover:bg-emerald-400"
                      : unlocked[i]
                        ? "border-white/30 text-gray-400 group-hover:border-emerald-500/60"
                        : "border-white/10 text-gray-700"
                }`}
              >
                {isDone ? (
                  <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
                    <path
                      d="M3 8.5 L6.5 12 L13 4.5"
                      className="fill-none stroke-current stroke-[2.5]"
                    />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={`text-xs font-bold tracking-[0.2em] uppercase ${isActive ? "inline" : "hidden xl:inline"} ${
                  isActive
                    ? "text-emerald-400"
                    : unlocked[i]
                      ? "text-gray-300 group-hover:text-emerald-400"
                      : "text-gray-700"
                }`}
              >
                {title}
              </span>
            </button>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={`mx-3 h-px min-w-4 flex-1 transition-colors ${done[i] ? "bg-emerald-500" : "bg-white/10"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
