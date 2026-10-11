import type { SavedRule } from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button, fieldClass } from "../ui";
import type { LoadedContract } from "./useRegisteredContract";

const NAME_MAX = 80;

/**
 * The contract's name, and a way to change it in place. Enter saves,
 * Escape puts the old name back.
 */
export function ContractName({ contract }: { contract: LoadedContract }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(contract.name);
  const field = useRef<HTMLInputElement>(null);
  // Opened by a click on Rename: the field takes the keyboard, name selected.
  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);
  const rename = useMutation({
    mutationFn: (next: string) => api.renameContract(contract.address, next),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["contract", contract.address], updated);
      setEditing(false);
      // Lists, rule pages and filters all show the name.
      await queryClient.invalidateQueries({ queryKey: ["contracts"] });
      await queryClient.invalidateQueries({ queryKey: ["trip-state"] });
    },
  });

  const trimmed = name.trim();
  const problem = !trimmed
    ? "A name is required."
    : trimmed.length > NAME_MAX
      ? `At most ${NAME_MAX} characters.`
      : null;
  const unchanged = trimmed === contract.name;

  const start = () => {
    setName(contract.name);
    rename.reset();
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    rename.reset();
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    if (unchanged) return cancel();
    rename.mutate(trimmed);
  };

  if (!editing) {
    return (
      <span className="flex items-center gap-3">
        <h1 className="font-display text-3xl font-bold tracking-tighter text-white uppercase md:text-4xl">
          {contract.name}
        </h1>
        <button
          type="button"
          onClick={start}
          title="Rename this contract"
          aria-label="Rename this contract"
          className="cursor-pointer p-1 text-gray-600 transition-colors hover:text-emerald-400"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            className="size-4"
          >
            <path d="M10.5 2.5l3 3L6 13H3v-3z" />
          </svg>
        </button>
      </span>
    );
  }

  return (
    <form onSubmit={save} className="flex w-full max-w-xl flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && cancel()}
          aria-label="Contract name"
          aria-invalid={!!problem}
          maxLength={NAME_MAX + 20}
          className={`${fieldClass} min-w-0 flex-1 font-display text-xl font-bold`}
        />
        <Button type="submit" disabled={!!problem || rename.isPending}>
          {rename.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="quiet" onClick={cancel} disabled={rename.isPending}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-gray-500">
        {problem ??
          rename.error?.message ??
          "The name lists, alerts and filters show. The address and ABI stay as they are."}
      </p>
    </form>
  );
}

/**
 * Removing a contract: what goes with it, said before anything goes. The
 * name must be typed to confirm, because rules and their whole history
 * cannot be brought back.
 */
export function RemoveContract({
  contract,
  rules,
}: {
  contract: LoadedContract;
  rules: SavedRule[] | undefined;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  // Read only once the dialog opens: what removing would take with it.
  const { data: violations } = useQuery({
    queryKey: ["violations", { contract: contract.address, count: true }],
    queryFn: ({ signal }) =>
      api.violations({ contract: contract.address, limit: 1000 }, signal),
    enabled: open,
  });
  const { data: live } = useQuery({
    queryKey: ["responses", "live", contract.address],
    queryFn: async ({ signal }) => {
      const [waiting, inFlight] = await Promise.all([
        api.responses("waiting", signal),
        api.responses("in_flight", signal),
      ]);
      return [...waiting, ...inFlight].filter(
        (r) => r.contract.address === contract.address,
      );
    },
    enabled: open,
  });

  const remove = useMutation({
    mutationFn: () => api.deleteContract(contract.address),
    onSuccess: async () => {
      setOpen(false);
      queryClient.removeQueries({ queryKey: ["contract", contract.address] });
      queryClient.removeQueries({ queryKey: ["rules", contract.address] });
      await navigate({ to: "/contracts" });
      await queryClient.invalidateQueries();
    },
  });

  const close = () => {
    setOpen(false);
    setTyped("");
    remove.reset();
  };

  const ruleCount = rules?.length ?? contract.ruleCount;
  const violationCount =
    violations === undefined
      ? null
      : violations.length >= 1000
        ? "1,000 or more"
        : violations.length.toLocaleString();
  const busy = (live?.length ?? 0) > 0;
  const confirmed = typed.trim() === contract.name;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-6 border border-red-500/20 px-6 py-5">
        <div className="max-w-xl">
          <p className="text-sm font-bold text-white">Remove this contract</p>
          <p className="mt-1 text-sm text-gray-500">
            Tripwire stops watching it and deletes its{" "}
            {ruleCount === 1 ? "rule" : `${ruleCount} rules`} with their
            violations and settled responses. To stop for a while instead,
            switch it off at the top of the page.
          </p>
        </div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Remove
        </Button>
      </div>

      <ConfirmDialog
        open={open}
        title={`Remove ${contract.name}?`}
        confirm={remove.isPending ? "Removing…" : "Remove for good"}
        pending={remove.isPending}
        blocked={busy || !confirmed || live === undefined}
        error={remove.error?.message}
        onConfirm={() => remove.mutate()}
        onClose={close}
      >
        {busy ? (
          <p className="text-amber-300">
            {live!.length === 1
              ? "A response for this contract is"
              : `${live!.length} responses for this contract are`}{" "}
            still waiting or in flight.{" "}
            {live!.length === 1
              ? "Reject it or let it settle"
              : "Reject them or let them settle"}{" "}
            on the{" "}
            <Link
              to="/responses"
              className="text-emerald-400 hover:text-emerald-300"
            >
              Responses page
            </Link>{" "}
            first; Tripwire never drops a transaction it may still send.
          </p>
        ) : (
          <>
            <p>This cannot be undone. Removing it deletes:</p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-gray-300">
              <li>
                {ruleCount === 0
                  ? "no rules (it has none)"
                  : ruleCount === 1
                    ? `its rule, ${rules?.[0]?.rule.name ?? ""}`
                    : `its ${ruleCount} rules`}
              </li>
              <li>
                {violationCount === null
                  ? "their violations (counting…)"
                  : violationCount === "0"
                    ? "no violations (it has none)"
                    : `${violationCount} ${violationCount === "1" ? "violation" : "violations"} and the responses settled for them`}
              </li>
              <li>
                {contract.source === "verified"
                  ? "its ABI and the verified source kept with it"
                  : "its pasted ABI"}
              </li>
            </ul>
            <p className="mt-3">
              Nothing changes on chain: a pause in place stays in place. You can
              register the address again later, starting with no rules and no
              history.
            </p>
            <label className="mt-5 block">
              <span className="mb-2 block text-xs text-gray-400">
                Type{" "}
                <span className="font-bold text-white">{contract.name}</span> to
                confirm
              </span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && confirmed && !remove.isPending) {
                    e.preventDefault();
                    remove.mutate();
                  }
                }}
                aria-label="Type the contract's name to confirm"
                autoComplete="off"
                spellCheck={false}
                className={fieldClass}
              />
            </label>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
