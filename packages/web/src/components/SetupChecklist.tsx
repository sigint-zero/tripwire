import type { SetupState } from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api";

const steps: {
  step: keyof SetupState["steps"];
  title: string;
  to: "/contracts" | "/rules/new" | "/notifications";
}[] = [
  { step: "contract", title: "Add a contract", to: "/contracts" },
  { step: "rule", title: "Create a rule", to: "/rules/new" },
  { step: "channel", title: "Connect an alert channel", to: "/notifications" },
];

/**
 * The first-run steps left after setup, each ticking itself as its state
 * appears. Gone once all are done, or dismissed for everyone.
 */
export function SetupChecklist() {
  const queryClient = useQueryClient();
  const { data: setup } = useQuery({
    queryKey: ["setup"],
    queryFn: ({ signal }) => api.setup(signal),
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissSetup(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["setup"] }),
  });

  if (!setup || setup.dismissed) return null;
  if (steps.every((s) => setup.steps[s.step])) return null;

  return (
    <section className="mb-8 bg-white/3 px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
          Get started
        </h2>
        <button
          type="button"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate()}
          className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-gray-200 disabled:opacity-50"
          title="Hide this for everyone"
        >
          Dismiss
        </button>
      </div>
      <ol className="grid gap-1 sm:grid-cols-3">
        {steps.map((s, i) => {
          const done = setup.steps[s.step];
          return (
            <li key={s.step}>
              <Link
                to={s.to}
                className={`flex items-center gap-3 px-3 py-2.5 text-xs transition-colors hover:bg-white/5 ${done ? "text-gray-500" : "text-white"}`}
              >
                <span
                  className={`flex size-5 shrink-0 items-center justify-center font-mono text-[10px] ${done ? "bg-emerald-500/15 text-emerald-400" : "bg-white/5 text-gray-400"}`}
                >
                  {done ? "✓" : i + 1}
                </span>
                <span className={done ? "line-through" : ""}>{s.title}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
