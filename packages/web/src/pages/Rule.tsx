import type { RuleDisplay, SavedRule } from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  Button,
  buttonClass,
  EmptyState,
  PinIcon,
  Switch,
  Tag,
} from "../components/ui";
import { RuleStatusTag } from "../components/RuleStatus";
import { RuleValues } from "../components/RuleValues";
import { ViolationList } from "../components/ViolationList";
import {
  actions,
  SeverityIcon,
  severities,
} from "../components/wizard/ResponseStep";
import { api } from "../lib/api";
import { formatBig, shortAddress, timeAgo } from "../lib/format";

const heading =
  "mb-4 text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase";

/** One rule: its switch, what it says, how its values show, and its violations. */
export function RulePage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: rule, error } = useQuery({
    queryKey: ["rule", id],
    queryFn: ({ signal }) => api.rule(id, signal),
  });
  const { data: contracts } = useQuery({
    queryKey: ["contracts"],
    queryFn: ({ signal }) => api.contracts(signal),
  });
  const { data: pinned } = useQuery({
    queryKey: ["pinned"],
    queryFn: ({ signal }) => api.pinnedRules(signal),
  });
  const { data: violations } = useQuery({
    queryKey: ["violations", { rule: id }],
    queryFn: ({ signal }) => api.violations({ rule: id, limit: 200 }, signal),
  });

  const changed = async (updated: SavedRule) => {
    queryClient.setQueryData(["rule", id], updated);
    await queryClient.invalidateQueries({ queryKey: ["rules"] });
    await queryClient.invalidateQueries({ queryKey: ["contracts"] });
  };
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.changeRule(id, { enabled }),
    onSuccess: changed,
  });
  const pin = useMutation({
    mutationFn: (on: boolean) =>
      api.pinRules(
        on ? [...(pinned ?? []), id] : (pinned ?? []).filter((p) => p !== id),
      ),
    onSuccess: (ids) => queryClient.setQueryData(["pinned"], ids),
  });
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteRule(id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ["rule", id] });
      await queryClient.invalidateQueries({ queryKey: ["rules"] });
      await queryClient.invalidateQueries({ queryKey: ["contracts"] });
      await queryClient.invalidateQueries({ queryKey: ["pinned"] });
      await navigate({ to: "/rules" });
    },
  });

  const back = (
    <Link
      to="/rules"
      className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
    >
      ← Rules
    </Link>
  );
  if (error) {
    return (
      <div className="space-y-4">
        {back}
        <p className="text-sm text-gray-400">{error.message}</p>
      </div>
    );
  }
  if (!rule) return back;

  const address = rule.rule.contract.toLowerCase();
  const contract = contracts?.find((c) => c.address === address);
  const severity = severities.find((s) => s.severity === rule.rule.severity);
  const action = actions.find((a) => a.action === rule.rule.on_trip.action);
  const isPinned = pinned?.includes(id) ?? false;
  const failure = toggle.error ?? pin.error;

  return (
    <div>
      {back}
      <header className="mt-4 mb-10 flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <h1 className="flex items-center gap-3 font-display text-3xl font-bold tracking-tighter text-white uppercase md:text-4xl">
              {rule.rule.name}
              {isPinned && (
                <span title="Pinned to the Overview" className="text-gray-400">
                  <PinIcon className="size-6" />
                </span>
              )}
            </h1>
            <Switch
              on={rule.enabled}
              onChange={(enabled) => toggle.mutate(enabled)}
              label={rule.enabled ? "Watching" : "Off"}
              disabled={toggle.isPending}
            />
          </div>
          <p className="mt-3 max-w-3xl font-mono text-sm text-gray-400">
            {rule.sentence}
          </p>
          <p className="mt-4 flex flex-wrap items-center gap-2">
            <Link
              to="/contracts/$address"
              params={{ address }}
              className="transition-opacity hover:opacity-80"
            >
              <Tag>{contract?.name ?? shortAddress(address)}</Tag>
            </Link>
            {/* The alert and action are settings, not states: no colour. */}
            {severity && (
              <span title="The alert it raises when it trips">
                <Tag>
                  <span className="mr-2 text-gray-600">Alert</span>
                  <SeverityIcon
                    severity={severity.severity}
                    className="mr-1.5 size-3"
                    plain
                  />
                  {severity.title}
                </Tag>
              </span>
            )}
            {action && (
              <span title="What Tripwire does when it trips">
                <Tag>
                  <span className="mr-2 text-gray-600">Action</span>
                  {action.title}
                </Tag>
              </span>
            )}
            {typeof rule.origin === "object" && (
              <Tag tone="text-violet-300">Via {rule.origin.mcp}</Tag>
            )}
            {rule.origin === "api" && <Tag tone="text-violet-300">Via API</Tag>}
            <RuleStatusTag status={rule.status} open={rule.openViolations} />
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            to="/rules/$id/edit"
            params={{ id }}
            className={buttonClass("ghost")}
          >
            Edit
          </Link>
          <Button
            variant="ghost"
            disabled={pin.isPending || pinned === undefined}
            onClick={() => pin.mutate(!isPinned)}
            title="Pinned rules show on the Overview"
          >
            <PinIcon />
            {isPinned ? "Unpin" : "Pin"}
          </Button>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete
          </Button>
          <ConfirmDialog
            open={confirming}
            title="Delete this rule?"
            confirm="Delete rule"
            pending={remove.isPending}
            error={remove.error?.message}
            onConfirm={() => remove.mutate()}
            onClose={() => {
              setConfirming(false);
              remove.reset();
            }}
          >
            <span className="font-mono text-white">{rule.rule.name}</span> stops
            watching, and its violations go with it. This cannot be undone.
            {rule.enabled && (
              <span className="mt-3 block text-gray-500">
                To pause it instead, switch it off.
              </span>
            )}
          </ConfirmDialog>
        </div>
      </header>

      {failure && (
        <p className="mb-10 text-sm text-red-400">{failure.message}</p>
      )}

      <dl className="mb-12 grid gap-2 sm:grid-cols-3">
        <Fact label="Last evaluated">
          {rule.lastEvaluatedBlock === null
            ? "Not yet"
            : `Block ${formatBig(String(rule.lastEvaluatedBlock))}`}
        </Fact>
        <Fact label="Created">
          <span title={new Date(rule.createdAt).toLocaleString()}>
            {timeAgo(rule.createdAt)}
          </span>
        </Fact>
        <Fact label="Changed">
          <span title={new Date(rule.updatedAt).toLocaleString()}>
            {timeAgo(rule.updatedAt)}
          </span>
        </Fact>
      </dl>

      <RuleValues rule={rule} violations={violations} />

      <section className="mb-12">
        <h2 className={heading}>How values show</h2>
        <DisplayForm
          key={`${rule.display.decimals}:${rule.display.unit}`}
          display={rule.display}
          onSave={changed}
          id={id}
        />
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className={heading}>Violations</h2>
          {violations && violations.length > 0 && (
            <Link
              to="/violations"
              search={{ rule: id, all: true }}
              className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-emerald-400"
            >
              Filter on the Violations page →
            </Link>
          )}
        </div>
        {violations?.length === 0 && (
          <EmptyState
            compact
            title="Never tripped"
            hint="When this rule trips, each run shows up here."
          />
        )}
        {violations && violations.length > 0 && (
          <ViolationList
            violations={violations}
            rules={[rule]}
            showRule={false}
          />
        )}
      </section>
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white/3 px-5 py-4">
      <dt className="text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-sm text-white tabular-nums">
        {children}
      </dd>
    </div>
  );
}

/** Decimals the raw value is divided by, and a unit after it. */
function DisplayForm({
  id,
  display,
  onSave,
}: {
  id: string;
  display: RuleDisplay;
  onSave: (rule: SavedRule) => Promise<void>;
}) {
  const [decimals, setDecimals] = useState(
    display.decimals === null ? "" : String(display.decimals),
  );
  const [unit, setUnit] = useState(display.unit ?? "");
  const save = useMutation({
    mutationFn: () =>
      api.changeRule(id, {
        display: {
          decimals: decimals === "" ? null : Number(decimals),
          unit: unit.trim() || null,
        },
      }),
    onSuccess: onSave,
  });
  const dirty =
    decimals !== (display.decimals === null ? "" : String(display.decimals)) ||
    unit !== (display.unit ?? "");
  const input =
    "bg-white/5 px-3 py-2 font-mono text-sm text-white placeholder:text-gray-600 focus:bg-white/8 focus:outline-none";

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="grid gap-1.5">
        <span
          className="text-xs text-gray-500"
          title="The raw value is divided by 10 to this power: 18 for most tokens, 6 for USDC"
        >
          Decimals
        </span>
        <input
          value={decimals}
          onChange={(e) => setDecimals(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          maxLength={2}
          placeholder="Raw"
          className={`w-24 ${input}`}
        />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs text-gray-500">Unit</span>
        <input
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          maxLength={16}
          placeholder="None"
          className={`w-32 ${input}`}
        />
      </label>
      <Button type="submit" disabled={!dirty || save.isPending}>
        Save
      </Button>
      {save.error && (
        <p className="w-full text-sm text-red-400">{save.error.message}</p>
      )}
    </form>
  );
}
