import { chainName, type EngineStatus } from "@tripwire/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useLive } from "../lib/live";

type Tone = "quiet" | "amber" | "red";

const tones: Record<Tone, string> = {
  quiet: "bg-white/3 text-gray-300 hover:bg-white/5",
  amber: "bg-amber-400/10 text-amber-300 hover:bg-amber-400/15",
  red: "bg-red-500/10 text-red-300 hover:bg-red-500/15",
};

const toneOf: Record<EngineStatus["state"], Tone> = {
  ready: "quiet",
  starting: "quiet",
  installing: "quiet",
  degraded: "amber",
  unconfigured: "amber",
  "stand-in": "amber",
  restarting: "red",
  unresponsive: "red",
  failed: "red",
  stopped: "red",
};

/** "4 s", "2 min": how long ago a block was seen. */
function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3_600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3_600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

function useSecond() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const mono = (text: string) => <span className="font-mono">{text}</span>;

/**
 * One line saying whether Tripwire is watching. The head moves with the
 * stream's blocks; its age counts here, so it keeps rising while no block
 * arrives.
 */
export function HealthStrip() {
  const { data: engine } = useQuery({
    queryKey: ["engine"],
    queryFn: ({ signal }) => api.engine(signal),
    staleTime: Infinity,
  });
  const { head: streamed } = useLive();
  const now = useSecond();

  if (!engine) return <div className="mb-8 h-10 bg-white/3" />;

  const known = engine.health;
  const head =
    streamed && (known?.head == null || streamed.number >= known.head)
      ? streamed
      : known?.head != null
        ? { number: known.head, time: known.headTime }
        : null;
  const ago = head?.time ? age(now - Date.parse(head.time)) : null;
  const lastSeen = ago && <> Last block seen {mono(ago)} ago.</>;
  const chain = chainName(engine.chainId);

  const sentence: Record<EngineStatus["state"], ReactNode> = {
    ready: (
      <>
        Watching {chain}.
        {head && (
          <>
            {" "}
            Block {mono(head.number.toLocaleString("en-US"))}
            {ago && <>, {mono(ago)} ago</>}.
          </>
        )}
      </>
    ),
    degraded: engine.problem ? (
      <>Behind: {engine.problem.message}</>
    ) : (
      <>
        Behind
        {known?.lagBlocks != null && (
          <>
            : {mono(known.lagBlocks.toLocaleString("en-US"))} blocks behind the
            chain head
          </>
        )}
        {known?.rpc && known.rpc !== "ok" && <>, RPC {known.rpc}</>}.
      </>
    ),
    starting: "Starting the engine.",
    installing: (
      <>
        Installing the engine.
        {engine.install?.total && (
          <>
            {" "}
            {mono(
              `${Math.floor((engine.install.bytes / engine.install.total) * 100)}%`,
            )}
          </>
        )}
      </>
    ),
    restarting: <>The engine stopped. Restarting.{lastSeen}</>,
    unresponsive: <>The engine is not answering.{lastSeen}</>,
    failed: (
      <>The engine cannot start: {engine.problem?.message ?? "unknown"}</>
    ),
    stopped: <>The engine is stopped.{lastSeen}</>,
    unconfigured: "No chain set up yet.",
    "stand-in": (
      <>
        Stand-in: simulated blocks, no chain.
        {head && <> Block {mono(head.number.toLocaleString("en-US"))}.</>}
      </>
    ),
  };

  const controller = known?.controller;
  const keys = known?.keys;
  const facts: { text: string; hint?: string }[] = [
    // The stand-in has no RPC to speak of.
    engine.runner !== "stand-in" &&
      known?.rpc && {
        text: `RPC ${known.rpc === "ok" ? "connected" : known.rpc}`,
      },
    controller && {
      text: `controller ${controller.address.slice(0, 6)}…${controller.address.slice(-4)}`,
      hint: `Mirroring the TripwireController at ${controller.address}${controller.mirroredBlock != null ? `, to block ${controller.mirroredBlock.toLocaleString("en-US")}` : ""}`,
    },
    keys &&
      keys.known > 0 && {
        text: `${keys.unlocked}/${keys.known} ${keys.known === 1 ? "key" : "keys"} unlocked`,
        hint: "Keys that can sign a response now, of those Tripwire has",
      },
    engine.runner !== "stand-in" &&
      engine.version && { text: `v${engine.version}` },
  ].filter((fact) => !!fact);
  const tone = toneOf[engine.state];

  return (
    <Link
      to={engine.state === "unconfigured" ? "/setup" : "/settings"}
      className={`mb-8 flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-xs transition-colors ${tones[tone]}`}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 ${engine.state === "ready" ? "bg-emerald-400" : "bg-current"}`}
      />
      <span className="min-w-48 flex-1">{sentence[engine.state]}</span>
      {facts.length > 0 && (
        <span className="ml-auto font-mono text-[10px] text-gray-500">
          {facts.map((fact, i) => (
            <span key={fact.text} title={fact.hint}>
              {i > 0 && " · "}
              {fact.text}
            </span>
          ))}
        </span>
      )}
    </Link>
  );
}
