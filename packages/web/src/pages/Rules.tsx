import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "../components/PageHeader";
import { RuleList } from "../components/RuleList";
import { buttonClass, EmptyState } from "../components/ui";
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
      <PageHeader
        title="Rules"
        description="Every rule with its current value and status."
        action={
          rules &&
          rules.length > 0 && (
            <Link to="/rules/new" className={buttonClass()}>
              New rule
            </Link>
          )
        }
      />

      {error && <p className="text-sm text-red-400">{error.message}</p>}

      {rules?.length === 0 && (
        <EmptyState
          title="Nothing watched yet"
          hint="Pick a contract and a starting point, then fill in the blanks."
        >
          <Link to="/rules/new" className={buttonClass()}>
            Create your first rule
          </Link>
        </EmptyState>
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
