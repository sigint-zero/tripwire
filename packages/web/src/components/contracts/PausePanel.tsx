import type {
  ManualAction,
  SavedRule,
  TripStateItem,
  WalletCall,
} from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import type { WriteFunction } from "../../lib/abi";
import { shortAddress } from "../../lib/format";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button, fieldClass, labelClass, Tag } from "../ui";

const quietLink =
  "cursor-pointer text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-gray-200";

/** An act on the controller, with the words its confirmation uses. */
interface Asking {
  action: Extract<ManualAction, { controller: string }>;
  call: string;
  what: string;
}

/**
 * What is paused on this contract now, and pausing or unpausing it by
 * hand during an incident (`RESPONSES.md`). The engine sends controller
 * pauses from the signing key; a call to the contract's own functions it
 * cannot make yet, so for those the panel gives the call to make from a
 * wallet.
 */
export function PausePanel({
  contract,
  rules,
}: {
  contract: {
    address: string;
    name: string;
    controller: { guardian: string } | null;
    surface: { writes: WriteFunction[] };
  };
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
  const [asking, setAsking] = useState<Asking | null>(null);
  const [note, setNote] = useState("");
  // Said until the paused rows change, which is the action landing.
  const [sent, setSent] = useState<{ text: string; rows: string } | null>(null);
  const rowsNow =
    paused?.map((p) => `${p.source}${p.selector}${p.sinceBlock}`).join() ?? "";
  const act = useMutation({
    mutationFn: (action: ManualAction) =>
      api.contractAction(contract.address, action),
    onSuccess: async (result) => {
      if (result.sent) {
        setSent({
          text: `${asking?.what ?? "Sent"}: sent. It shows here once it confirms.`,
          rows: rowsNow,
        });
      }
      setAsking(null);
      setNote("");
      await queryClient.invalidateQueries({ queryKey: ["trip-state"] });
    },
  });
  const ask = (next: Asking) => {
    act.reset();
    setSent(null);
    setAsking(next);
  };
  const globallyPaused = !!paused?.some(
    (p) => p.scope === "global" && p.source === "controller",
  );
  const writes = contract.surface.writes;
  const [fn, setFn] = useState(writes[0]?.selector ?? "");
  const chosen = writes.find((w) => w.selector === fn);

  return (
    <div className="space-y-4">
      <ul className="space-y-1">
        {paused?.length === 0 && (
          <li className="bg-white/2 px-5 py-3.5 text-sm text-gray-500">
            Nothing is paused.
          </li>
        )}
        {paused?.map((row) => (
          <PausedRow
            key={`${row.source}:${row.selector ?? ""}`}
            row={row}
            onUnpause={
              row.source === "controller" && contract.controller
                ? () =>
                    ask(
                      row.scope === "global"
                        ? {
                            action: {
                              controller: "unpause",
                              scope: "contract",
                            },
                            call: `resetGlobal(${contract.name})`,
                            what: `Unpause ${contract.name}`,
                          }
                        : {
                            action: {
                              controller: "unpause",
                              scope: "function",
                              selector: row.selector!,
                            },
                            call: `reset(${contract.name}, ${row.function ?? row.selector})`,
                            what: `Unpause ${row.function ?? row.selector}`,
                          },
                    )
                : undefined
            }
          />
        ))}
      </ul>

      {sent && sent.rows === rowsNow && (
        <p className="text-xs text-emerald-400">{sent.text}</p>
      )}

      {contract.controller && (
        <div className="flex flex-wrap items-end gap-3 bg-white/2 px-5 py-4">
          <Button
            variant="danger"
            disabled={globallyPaused}
            title={globallyPaused ? "Already paused" : undefined}
            onClick={() =>
              ask({
                action: { controller: "pause", scope: "contract" },
                call: `tripGlobal(${contract.name})`,
                what: `Pause ${contract.name}`,
              })
            }
          >
            Pause the contract
          </Button>
          {writes.length > 0 && (
            <>
              <label className="min-w-56 flex-1">
                <span className={labelClass}>Or one function</span>
                <select
                  className={`${fieldClass} font-mono`}
                  value={fn}
                  onChange={(e) => setFn(e.target.value)}
                >
                  {writes.map((w) => (
                    <option key={w.selector} value={w.selector}>
                      {w.signature}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="danger"
                disabled={!chosen}
                onClick={() =>
                  chosen &&
                  ask({
                    action: {
                      controller: "pause",
                      scope: "function",
                      selector: chosen.selector,
                    },
                    call: `trip(${contract.name}, ${chosen.signature})`,
                    what: `Pause ${chosen.signature}`,
                  })
                }
              >
                Pause it
              </Button>
            </>
          )}
        </div>
      )}

      <OwnCall contract={contract} rules={rules} />

      <ConfirmDialog
        open={asking !== null}
        title={`${asking?.what ?? ""}?`}
        confirm={asking?.what ?? "Send"}
        pending={act.isPending}
        error={act.error?.message}
        onConfirm={() => {
          if (asking) {
            act.mutate({
              ...asking.action,
              ...(note.trim() ? { note: note.trim() } : {}),
            });
          }
        }}
        onClose={() => {
          setAsking(null);
          act.reset();
        }}
      >
        <span className="block">
          Tripwire sends{" "}
          <code className="font-mono text-white">{asking?.call}</code> to the
          controller from its signing key, now, whatever the response mode.
          {asking?.action.controller === "unpause" &&
            asking.action.scope === "contract" &&
            " Paused functions stay paused."}
        </span>
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

function PausedRow({
  row,
  onUnpause,
}: {
  row: TripStateItem;
  onUnpause?: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 bg-red-500/8 px-5 py-3.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span aria-hidden className="size-1.5 shrink-0 bg-red-400" />
        <span className="font-mono text-white">
          {row.scope === "global"
            ? "Every function"
            : (row.function ?? row.selector)}
        </span>
        <Tag>{row.source === "controller" ? "Controller" : "Own pause"}</Tag>
        <span className="font-mono text-xs text-gray-500">
          since #{row.sinceBlock.toLocaleString("en-US")}
        </span>
        {row.actor && (
          <span className="text-xs text-gray-500">
            by {row.actor.rule.name}
          </span>
        )}
        {row.rules.length > 0 && (
          <span className="text-xs text-gray-500">
            confirmed by {row.rules.map((r) => r.name).join(", ")}
          </span>
        )}
        {row.txHash && (
          <span className="font-mono text-xs text-gray-600" title={row.txHash}>
            {shortAddress(row.txHash)}
          </span>
        )}
      </span>
      {onUnpause && (
        <button type="button" className={quietLink} onClick={onUnpause}>
          Unpause
        </button>
      )}
    </li>
  );
}

/**
 * A call to one of the contract's own functions, such as its pause() or
 * unpause(). Tripwire cannot send one by hand yet, so this gives the call
 * to make from a wallet that holds the permission.
 */
function OwnCall({
  contract,
  rules,
}: {
  contract: { address: string; surface: { writes: WriteFunction[] } };
  rules: SavedRule[] | undefined;
}) {
  // The calls the contract's rules would make come first.
  const ruled = new Set(
    (rules ?? []).flatMap((r) =>
      r.rule.on_trip.action === "call" ? [r.rule.on_trip.call.function] : [],
    ),
  );
  const writes = [...contract.surface.writes].sort(
    (a, b) => Number(ruled.has(b.signature)) - Number(ruled.has(a.signature)),
  );
  const [fn, setFn] = useState(writes[0]?.signature ?? "");
  const [args, setArgs] = useState<string[]>([]);
  const chosen = writes.find((w) => w.signature === fn);
  const show = useMutation({
    mutationFn: () =>
      api.contractAction(contract.address, {
        call: {
          function: fn,
          args: chosen?.inputs.map((_, i) => args[i] ?? "") ?? [],
        },
      }),
  });
  const wallet: WalletCall | undefined = show.data?.wallet;

  if (writes.length === 0) return null;
  return (
    <div className="space-y-3 bg-white/2 px-5 py-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-56 flex-1">
          <span className={labelClass}>Call one of its own functions</span>
          <select
            className={`${fieldClass} font-mono`}
            value={fn}
            onChange={(e) => {
              setFn(e.target.value);
              setArgs([]);
              show.reset();
            }}
          >
            {writes.map((w) => (
              <option key={w.selector} value={w.signature}>
                {w.signature}
                {ruled.has(w.signature) ? "  (a rule calls it)" : ""}
              </option>
            ))}
          </select>
        </label>
        {chosen?.inputs.map((input, i) => (
          <label key={i} className="min-w-40">
            <span className={labelClass}>{input.name || input.type}</span>
            <input
              className={`${fieldClass} font-mono`}
              value={args[i] ?? ""}
              placeholder={input.type}
              onChange={(e) => {
                const next = [...args];
                next[i] = e.target.value;
                setArgs(next);
                show.reset();
              }}
            />
          </label>
        ))}
        <Button
          variant="ghost"
          disabled={show.isPending || !chosen}
          onClick={() => show.mutate()}
          title="Tripwire cannot send a call by hand yet: this gives the call to make from a wallet"
        >
          Show the call
        </Button>
      </div>
      {show.error && (
        <p className="text-xs text-red-400">{show.error.message}</p>
      )}
      {wallet && (
        <div className="space-y-1 font-mono text-xs text-gray-300">
          <p className="font-sans text-gray-400">
            Send this from a wallet allowed to call {fn}:
          </p>
          <p className="break-all">
            <span className="text-gray-500">To </span>
            {wallet.to}
          </p>
          <p>
            <span className="text-gray-500">Value </span>
            {wallet.value}
          </p>
          <p className="break-all">
            <span className="text-gray-500">Data </span>
            {wallet.data}
          </p>
        </div>
      )}
    </div>
  );
}
