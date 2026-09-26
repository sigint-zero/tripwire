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

  const facts = [
    // The stand-in has no RPC to speak of.
    engine.runner !== "stand-in" &&
      known?.rpc &&
      `RPC ${known.rpc === "ok" ? "connected" : known.rpc}`,
    engine.runner !== "stand-in" && engine.version && `v${engine.version}`,
  ].filter(Boolean);
  const tone = toneOf[engine.state];

  return (
    <Link
      to={engine.state === "unconfigured" ? "/setup" : "/settings"}
      className={`mb-8 flex min-h-10 items-center gap-3 px-4 py-2.5 text-xs transition-colors ${tones[tone]}`}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 ${engine.state === "ready" ? "bg-emerald-400" : "bg-current"}`}
      />
      <span className="min-w-0 flex-1">{sentence[engine.state]}</span>
      {facts.length > 0 && (
        <span className="shrink-0 font-mono text-[10px] text-gray-500">
          {facts.join(" · ")}
        </span>
      )}
    </Link>
  );
}
