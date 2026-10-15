import type { SavedRule } from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button, fieldClass, labelClass } from "../ui";
import type { LoadedContract } from "./useRegisteredContract";

const NAME_MAX = 80;

/**
 * Edit, in the contract's header: its name, in a dialog. Only the name
 * changes; the address and ABI are what its rules were checked against.
 */
export function EditContract({ contract }: { contract: LoadedContract }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(contract.name);
  const field = useRef<HTMLInputElement>(null);
  // Once the dialog is showing, the field takes the keyboard, name selected.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => field.current?.select());
    return () => clearTimeout(timer);
  }, [open]);
  const rename = useMutation({
    mutationFn: (next: string) => api.renameContract(contract.address, next),
    onSuccess: async (updated) => {
      queryClient.setQueryData(["contract", contract.address], updated);
      setOpen(false);
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
    setOpen(true);
  };
  const save = () => {
    if (problem || rename.isPending) return;
    if (unchanged) return setOpen(false);
    rename.mutate(trimmed);
  };

  return (
    <>
      <Button variant="ghost" onClick={start} title="Edit this contract">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          className="size-3.5 shrink-0"
        >
          <path d="M10.5 2.5l3 3L6 13H3v-3z" />
        </svg>
        Edit
      </Button>
      <ConfirmDialog
        open={open}
        title="Edit the contract"
        confirm={rename.isPending ? "Saving…" : "Save"}
        tone="go"
        pending={rename.isPending}
        blocked={!!problem}
        error={rename.error?.message}
        onConfirm={save}
        onClose={() => setOpen(false)}
      >
        <label className="block">
          <span className={labelClass}>Name</span>
          <input
            ref={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            aria-label="Contract name"
            aria-invalid={!!problem}
            maxLength={NAME_MAX + 20}
            autoComplete="off"
            className={fieldClass}
          />
        </label>
        <p className="mt-2 text-xs text-gray-500">
          {problem ?? "What lists, alerts and filters call it."}
        </p>
        <p className="mt-4 text-xs text-gray-500">
          The address and ABI stay as they are: its rules were checked against
          them. For a different ABI, remove the contract and register it again.
        </p>
      </ConfirmDialog>
    </>
  );
}

/**
 * Remove, in the contract's header: what goes with it, said before anything goes. The
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

  // Read once the dialog opens: what removing would take with it. The
  // count is kept apart from the violations lists, so a new violation does
  // not reload a thousand rows while the dialog is open.
  const { data: violations } = useQuery({
    queryKey: ["removal", contract.address, "violations"],
    queryFn: ({ signal }) =>
      api.violations({ contract: contract.address, limit: 1000 }, signal),
    enabled: open,
    staleTime: Infinity,
    gcTime: 0,
  });
  const liveQuery = useQuery({
    queryKey: ["responses", "live", contract.address],
    queryFn: async ({ signal }) => {
      const [waiting, inFlight] = await Promise.all([
        api.responses("waiting", signal, contract.address),
        api.responses("in_flight", signal, contract.address),
      ]);
      return [...waiting, ...inFlight];
    },
    enabled: open,
    // Removal waits on this answer, so a failure is shown, not retried long.
    retry: 1,
  });
  const live = liveQuery.data;

  const remove = useMutation({
    mutationFn: () => api.deleteContract(contract.address),
    // The server checks again; a response that went live since the dialog
    // opened is shown as the dialog shows one found at opening.
    onError: (error) => {
      if (error instanceof ApiError && error.code === "live_response") {
        void liveQuery.refetch();
      }
    },
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
  // One condition for the button and for Enter in the field.
  const removable = live !== undefined && !busy && confirmed;

  return (
    <>
      <Button
        variant="danger"
        onClick={() => setOpen(true)}
        title="Remove this contract"
        aria-label="Remove this contract"
        className="px-3"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          className="size-3.5 shrink-0"
        >
          <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.75 9.5h6.5L12 4M6.75 6.5v4.5M9.25 6.5v4.5" />
        </svg>
      </Button>

      <ConfirmDialog
        open={open}
        title={`Remove ${contract.name}?`}
        confirm={remove.isPending ? "Removing…" : "Remove for good"}
        pending={remove.isPending}
        blocked={!removable}
        error={
          remove.error && !busy
            ? remove.error.message
            : liveQuery.error
              ? `Could not check for responses still waiting: ${liveQuery.error.message}. Close this and try again.`
              : undefined
        }
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
            {live === undefined && !liveQuery.error && (
              <p className="mt-3 text-gray-500">
                Checking for responses still waiting…
              </p>
            )}
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
                  if (e.key === "Enter" && removable && !remove.isPending) {
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
