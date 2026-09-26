import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "../components/PageHeader";
import { actions, severities } from "../components/wizard/ResponseStep";
import { api } from "../lib/api";
import { shortAddress } from "../lib/format";

const newButton =
  "inline-flex border border-emerald-500 bg-emerald-500/10 px-6 py-2.5 text-xs font-bold tracking-[0.2em] text-emerald-400 uppercase transition-colors hover:bg-emerald-500 hover:text-black";

export function RulesPage({ created }: { created?: string }) {
  const { data: rules, error } = useQuery({
    queryKey: ["rules"],
    queryFn: ({ signal }) => api.rules(signal),
  });

  return (
    <div>
      <div className="flex items-start justify-between gap-6">
        <PageHeader
          title="Rules"
          description="Every rule with its current value and status."
        />
        <Link to="/rules/new" className={`${newButton} shrink-0`}>
          New rule
        </Link>
      </div>

      {error && <p className="text-sm text-red-400">{error.message}</p>}

      {rules?.length === 0 && (
        <div className="border border-dashed border-white/10 px-6 py-16 text-center">
          <p className="font-display text-xl font-bold text-white uppercase">
            Nothing watched yet
          </p>
          <p className="mt-2 mb-6 text-sm text-gray-500">
            Paste a contract address, pick a starting point and fill in the
            blanks.
          </p>
          <Link to="/rules/new" className={newButton}>
            Create your first rule
          </Link>
        </div>
      )}

      {rules && rules.length > 0 && (
        <ul className="divide-y divide-white/5 border border-white/5">
          {rules.map((saved) => {
            const severity = severities.find(
              (s) => s.severity === saved.rule.severity,
            );
            const action = actions.find(
              (a) => a.action === saved.rule.on_trip.action,
            );
            const isNew = saved.id === created;
            return (
              <li
                key={saved.id}
                className={`grid gap-2 px-5 py-4 transition-colors md:grid-cols-[1fr_auto] md:items-center ${
                  isNew ? "bg-emerald-500/10" : "bg-panel"
                }`}
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-bold tracking-wider text-white uppercase">
                    <span
                      className={`size-1.5 ${saved.enabled ? "bg-emerald-500" : "bg-gray-600"}`}
                    />
                    {saved.rule.name}
                    {isNew && (
                      <span className="text-[10px] tracking-[0.2em] text-emerald-400">
                        New
                      </span>
                    )}
                  </p>
                  <p className="mt-1 truncate font-mono text-xs text-gray-400">
                    {saved.sentence}
                  </p>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span className="font-mono">
                    {shortAddress(saved.rule.contract)}
                  </span>
                  {severity && (
                    <span className="flex items-center gap-1.5 text-[10px] font-bold tracking-[0.2em] uppercase">
                      <span className={`size-1.5 ${severity.dot}`} />
                      {severity.title}
                    </span>
                  )}
                  {action && (
                    <span className="text-[10px] font-bold tracking-[0.2em] uppercase">
                      {action.title}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
