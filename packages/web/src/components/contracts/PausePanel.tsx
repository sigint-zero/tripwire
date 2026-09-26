import type { ManualAction, SavedRule, TripStateItem } from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { encodeCall, type WriteFunction } from "../../lib/abi";
import { shortAddress } from "../../lib/format";
import { ConfirmDialog } from "../ConfirmDialog";
import { Copyable } from "../Copyable";
import { Button, fieldClass, labelClass } from "../ui";

const quietLink =
  "cursor-pointer text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-gray-200";

/**
 * Sends an action, or throws the engine's reason it was not sent: a
 * failed pre-flight or a locked key is recorded as failed, not refused.
 */
async function send(address: string, action: ManualAction) {
  const item = await api.contractAction(address, action);
  if (item.status === "failed") {
    throw new Error(`Not sent: ${item.error ?? "the engine gave no reason"}.`);
  }
  return item;
}

/** What a confirmation is about to send. */
type Asking =
  | {
      kind: "controller";
      action: Extract<ManualAction, { controller: string }>;
      what: string;
      explain: string;
    }
  | { kind: "call"; fn: string; args: string[]; data: string };

type Contract = {
  address: string;
  name: string;
  controller: { guardian: string } | null;
  surface: { writes: WriteFunction[] };
};

/**
 * What is paused on this contract now, and pausing it by hand during an
 * incident (`RESPONSES.md`, Pausing and unpausing by hand). The status
 * comes first; the ways to pause stay behind one button, offering the
 * contract's own pause switch before anything else.
 */
export function PausePanel({
  contract,
  rules,
}: {
  contract: Contract;
  rules: SavedRule[] | undefined;
}) {
  const queryClient = useQueryClient();
  const address = contract.address.toLowerCase();
  const { data: paused } = useQuery({
    queryKey: ["trip-state"],
    queryFn: ({ signal }) => api.tripState(signal),
    select: (all) =>
      all.filter((p) => p.contract.address.toLowerCase() === address),
  });
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: (next: Asking) =>
      send(
        contract.address,
        next.kind === "controller"
          ? { ...next.action, ...(note.trim() ? { note: note.trim() } : {}) }
          : {
              call: { function: next.fn, args: next.args },
              ...(note.trim() ? { note: note.trim() } : {}),
            },
      ),
    onSuccess: async (_item, next) => {
      setSent(
        `${next.kind === "call" ? `${next.fn} sent` : `${next.what}: sent`}. It shows here once it lands.`,
      );
      setAsking(null);
      setNote("");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["trip-state"] });
    },
  });
  const ask = (next: Asking) => {
    act.reset();
    setSent(null);
    setAsking(next);
  };
  const call = (fn: string, args: string[] = []) =>
    ask({ kind: "call", fn, args, data: encodeCall(fn, args) });

  const writes = contract.surface.writes;
  const find = (name: string) =>
    writes.find((w) => w.signature === `${name}()`);
  const ownPause = find("pause");
  const ownUnpause = find("unpause");
  const globallyPaused = !!paused?.some(
    (p) => p.scope === "global" && p.source === "controller",
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {paused?.length === 0 ? (
          <p className="text-sm text-gray-400">Nothing is paused.</p>
        ) : (
          <span />
        )}
        {!open && (writes.length > 0 || contract.controller) && (
          <button
            type="button"
            className={quietLink}
            onClick={() => {
              setSent(null);
              setOpen(true);
            }}
          >
            Pause by hand
          </button>
        )}
      </div>

      {paused && paused.length > 0 && (
        <ul className="space-y-1">
          {paused.map((row) => (
            <PausedRow
              key={`${row.source}:${row.selector ?? ""}`}
              row={row}
              onUnpause={unpauseFor(row, contract, ownUnpause, ask, call)}
            />
          ))}
        </ul>
      )}

      {sent && <p className="text-xs text-emerald-400">{sent}</p>}

      {open && (
        <div className="space-y-3 bg-white/2 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <p className="text-sm text-gray-400">
              Pause {contract.name} yourself, now. Tripwire sends it from its
              own wallet, whatever the response mode. For an incident.
            </p>
            <button
              type="button"
              className={quietLink}
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
          <ul className="space-y-1">
            {ownPause && (
              <Choice
                title={`Call ${contract.name}'s pause()`}
                hint="Its own pause switch. Tripwire's wallet needs the role that may call it."
                onClick={() => call("pause()")}
                action="Pause"
              />
            )}
            {contract.controller && (
              <Choice
                title="Pause every function, through the controller"
                hint={
                  globallyPaused
                    ? "Already paused."
                    : `${contract.name} is registered with the controller; Tripwire's wallet must be an operator.`
                }
                disabled={globallyPaused}
                onClick={() =>
                  ask({
                    kind: "controller",
                    action: { controller: "pause", scope: "contract" },
                    what: `Pause ${contract.name}`,
                    explain: `the controller's pause of every function of ${contract.name}`,
                  })
                }
                action="Pause"
              />
            )}
            {contract.controller && writes.length > 0 && (
              <ControllerFunction
                writes={writes}
                onPick={(w) =>
                  ask({
                    kind: "controller",
                    action: {
                      controller: "pause",
                      scope: "function",
                      selector: w.selector,
                    },
                    what: `Pause ${w.signature}`,
                    explain: `the controller's pause of ${w.signature} alone`,
                  })
                }
              />
            )}
            {writes.length > 0 && (
              <OtherCall writes={writes} rules={rules} onCall={call} />
            )}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={asking !== null}
        title={
          asking?.kind === "call"
            ? `Call ${asking.fn} on ${contract.name}?`
            : `${asking?.what ?? ""}?`
        }
        confirm={
          asking?.kind === "call"
            ? `Call ${asking.fn}`
            : (asking?.what ?? "Send")
        }
        pending={act.isPending}
        error={
          act.error
            ? `${act.error.message}${asking?.kind === "call" ? " The call above can go from a wallet allowed to make it." : ""}`
            : undefined
        }
        onConfirm={() => asking && act.mutate(asking)}
        onClose={() => {
          setAsking(null);
          act.reset();
        }}
      >
        {asking?.kind === "call" ? (
          <>
            <span className="block">
              Tripwire sends{" "}
              <code className="font-mono text-white">
                {asking.fn.replace(/\(.*\)$/, "")}({asking.args.join(", ")})
              </code>{" "}
              to {contract.name} from its wallet, now.
            </span>
            <div className="mt-4">
              <p className="mb-1 text-xs text-gray-500">
                If Tripwire cannot send it, the same call from a wallet allowed
                to make it:
              </p>
              <Copyable label="To" value={contract.address} />
              <Copyable label="Data" value={asking.data} />
            </div>
          </>
        ) : (
          <span className="block">
            Tripwire sends {asking?.explain} from its wallet, now.
            {asking?.kind === "controller" &&
              asking.action.controller === "unpause" &&
              asking.action.scope === "contract" &&
              " Functions paused one by one stay paused."}
          </span>
        )}
        <label className="mt-4 block">
          <span className={labelClass}>Note (optional)</span>
          <input
            className={fieldClass}
            value={note}
            maxLength={500}
            placeholder="Why, for the record"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}

/** How to lift a pause: the controller's reset, or the contract's own unpause(). */
function unpauseFor(
  row: TripStateItem,
  contract: Contract,
  ownUnpause: WriteFunction | undefined,
  ask: (next: Asking) => void,
  call: (fn: string) => void,
): (() => void) | undefined {
  if (row.source === "controller" && contract.controller) {
    const what = row.function ?? row.selector;
    return () =>
      ask(
        row.scope === "global"
          ? {
              kind: "controller",
              action: { controller: "unpause", scope: "contract" },
              what: `Unpause ${contract.name}`,
              explain: `the controller's unpause of ${contract.name}`,
            }
          : {
              kind: "controller",
              action: {
                controller: "unpause",
                scope: "function",
                selector: row.selector!,
              },
              what: `Unpause ${what}`,
              explain: `the controller's unpause of ${what}`,
            },
      );
  }
  if (row.source === "verify" && ownUnpause) return () => call("unpause()");
  return undefined;
}

function Choice({
  title,
  hint,
  action,
  disabled,
  onClick,
  children,
}: {
  title: string;
  hint: string;
  action: string;
  disabled?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 bg-black/20 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-white">{title}</span>
        <span className="block text-xs text-gray-500">{hint}</span>
        {children}
      </span>
      <Button variant="danger" disabled={disabled} onClick={onClick}>
        {action}
      </Button>
    </li>
  );
}

/** The controller's pause of one function, chosen from the contract's writes. */
function ControllerFunction({
  writes,
  onPick,
}: {
  writes: WriteFunction[];
  onPick: (w: WriteFunction) => void;
}) {
  const [fn, setFn] = useState("");
  const chosen = writes.find((w) => w.selector === fn);
  return (
    <Choice
      title="Pause one function, through the controller"
      hint="The rest keep working."
      action="Pause"
      disabled={!chosen}
      onClick={() => chosen && onPick(chosen)}
    >
      <select
        className={`${fieldClass} mt-2 font-mono`}
        value={fn}
        onChange={(e) => setFn(e.target.value)}
      >
        <option value="">Choose a function…</option>
        {writes.map((w) => (
          <option key={w.selector} value={w.selector}>
            {w.signature}
          </option>
        ))}
      </select>
    </Choice>
  );
}

/** Any other of the contract's functions, with its arguments. */
function OtherCall({
  writes,
  rules,
  onCall,
}: {
  writes: WriteFunction[];
  rules: SavedRule[] | undefined;
  onCall: (fn: string, args: string[]) => void;
}) {
  const [shown, setShown] = useState(false);
  const [fn, setFn] = useState("");
  const [args, setArgs] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<string | null>(null);
  // The calls the contract's rules would make come first.
  const ruled = new Set(
    (rules ?? []).flatMap((r) =>
      r.rule.on_trip.action === "call" ? [r.rule.on_trip.call.function] : [],
    ),
  );
  const sorted = [...writes].sort(
    (a, b) => Number(ruled.has(b.signature)) - Number(ruled.has(a.signature)),
  );
  const chosen = writes.find((w) => w.signature === fn);
  const typed = chosen?.inputs.map((_, i) => args[i] ?? "") ?? [];

  if (!shown) {
    return (
      <li className="px-4 pt-1">
        <button
          type="button"
          className={quietLink}
          onClick={() => setShown(true)}
        >
          Call another function…
        </button>
      </li>
    );
  }
  return (
    <Choice
      title="Call another of its functions"
      hint="Sent as you type it, from Tripwire's wallet."
      action="Call"
      disabled={!chosen}
      onClick={() => {
        try {
          onCall(fn, typed);
        } catch (error) {
          setInvalid(
            error instanceof Error
              ? error.message.split("\n")[0]!
              : String(error),
          );
        }
      }}
    >
      <span className="mt-2 flex flex-wrap gap-2">
        <select
          className={`${fieldClass} min-w-56 flex-1 font-mono`}
          value={fn}
          onChange={(e) => {
            setFn(e.target.value);
            setArgs([]);
            setInvalid(null);
          }}
        >
          <option value="">Choose a function…</option>
          {sorted.map((w) => (
            <option key={w.selector} value={w.signature}>
              {w.signature}
              {ruled.has(w.signature) ? "  (a rule calls it)" : ""}
            </option>
          ))}
        </select>
        {chosen?.inputs.map((input, i) => (
          <input
            key={i}
            className={`${fieldClass} w-40 font-mono`}
            value={args[i] ?? ""}
            placeholder={input.name || input.type}
            title={input.type}
            onChange={(e) => {
              const next = [...args];
              next[i] = e.target.value;
              setArgs(next);
              setInvalid(null);
            }}
          />
        ))}
      </span>
      {invalid && (
        <span className="mt-1 block text-xs text-red-400">{invalid}</span>
      )}
    </Choice>
  );
}

function PausedRow({
  row,
  onUnpause,
}: {
  row: TripStateItem;
  onUnpause?: () => void;
}) {
  const what =
    row.scope === "global"
      ? "Every function"
      : (row.function ?? row.selector ?? "A function");
  const by = row.actor
    ? row.actor.is === "tripwire_response"
      ? `by Tripwire, for ${row.actor.rule.name}`
      : `by hand${row.actor.by ? `, ${row.actor.by}` : ""}`
    : null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 bg-red-500/8 px-5 py-3.5">
      <span className="min-w-0 text-sm">
        <span className="flex flex-wrap items-center gap-x-2">
          <span aria-hidden className="size-1.5 shrink-0 bg-red-400" />
          <span className="font-mono text-white">{what}</span>
          <span className="text-gray-400">
            {row.source === "controller"
              ? `paused through the controller${by ? ` ${by}` : ""}`
              : `in effect: the contract's own pause is on${by ? `, ${by}` : ""}`}
          </span>
        </span>
        <span
          className="mt-0.5 block text-xs text-gray-500"
          title={
            row.actor?.is === "tripwire_manual"
              ? (row.actor.note ?? undefined)
              : undefined
          }
        >
          Since block {row.sinceBlock.toLocaleString("en-US")}
          {row.rules.length > 0 &&
            ` · seen by ${row.rules.map((r) => r.name).join(", ")}`}
          {row.txHash && (
            <span className="font-mono" title={row.txHash}>
              {" "}
              · {shortAddress(row.txHash)}
            </span>
          )}
        </span>
      </span>
      {onUnpause && (
        <button type="button" className={quietLink} onClick={onUnpause}>
          Unpause
        </button>
      )}
    </li>
  );
}
