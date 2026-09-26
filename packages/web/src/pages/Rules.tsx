import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "../components/PageHeader";
import { RuleList } from "../components/RuleList";
import { buttonClass } from "../components/ui";
import { api } from "../lib/api";

export function RulesPage({ created }: { created?: string }) {
  const { data: rules, error } = useQuery({
    queryKey: ["rules"],
    queryFn: ({ signal }) => api.rules(undefined, signal),
  });
  const { data: contracts } = useQuery({
    queryKey: ["contracts"],
    queryFn: ({ signal }) => api.contracts(signal),
  });

  return (
    <div>
      <div className="flex items-start justify-between gap-6">
        <PageHeader
          title="Rules"
          description="Every rule with its current value and status."
        />
        <Link to="/rules/new" className={`${buttonClass()} shrink-0`}>
          New rule
        </Link>
      </div>

      {error && <p className="text-sm text-red-400">{error.message}</p>}

      {rules?.length === 0 && (
        <div className="bg-white/2 px-6 py-16 text-center">
          <p className="font-display text-xl font-bold text-white uppercase">
            Nothing watched yet
          </p>
          <p className="mt-2 mb-6 text-sm text-gray-500">
            Pick a contract and a starting point, then fill in the blanks.
          </p>
          <Link to="/rules/new" className={buttonClass()}>
            Create your first rule
          </Link>
        </div>
      )}

      {rules && rules.length > 0 && (
        <RuleList
          rules={rules}
          contracts={contracts ?? []}
          highlight={created}
        />
      )}
    </div>
  );
}
