import type { SavedRule } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useRegisteredContract } from "../components/contracts/useRegisteredContract";
import type { ContractSurface } from "../lib/abi";
import { api } from "../lib/api";
import { recoverTemplate } from "../lib/templates";
import { NewRulePage } from "./NewRule";

const backLink =
  "text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400";

/**
 * A stored rule, opened in the same wizard that creates one: with its
 * starting point when one reads the document back into blanks, else with
 * its condition as JSON.
 */
export function EditRulePage({ id }: { id: string }) {
  const { data: saved, error } = useQuery({
    queryKey: ["rule", id],
    queryFn: ({ signal }) => api.rule(id, signal),
  });
  const { contract, error: contractError } = useRegisteredContract(
    saved ? saved.rule.contract.toLowerCase() : null,
  );
  const failure = error ?? contractError;

  const back = (
    <Link to="/rules/$id" params={{ id }} className={backLink}>
      ← The rule
    </Link>
  );
  if (failure) {
    return (
      <div className="space-y-4">
        {back}
        <p className="text-sm text-gray-400">{failure.message}</p>
      </div>
    );
  }
  if (!saved || !contract) return back;
  return <Opened saved={saved} surface={contract.surface} />;
}

function Opened({
  saved,
  surface,
}: {
  saved: SavedRule;
  surface: ContractSurface;
}) {
  // Read back once, so a refetch of the rule does not reshape the page.
  const [recovered] = useState(() => recoverTemplate(saved.rule, surface));
  return (
    <NewRulePage
      editing={{
        id: saved.id,
        rule: saved.rule,
        templateId: recovered?.template.id ?? null,
        values: recovered?.values ?? null,
      }}
    />
  );
}
