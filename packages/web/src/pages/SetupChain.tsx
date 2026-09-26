import { chains, type ChainSetup, type ChainVerify } from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard } from "../components/AuthCard";
import { Button, fieldClass, labelClass } from "../components/ui";
import { api } from "../lib/api";

const OTHER = "other";

/**
 * First run's chain step (`FIRST-RUN.md`): the chain and its RPC
 * endpoint, verified through the engine before anything is saved, then
 * the engine started on it, with its progress shown until it is ready.
 */
export function SetupChainPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState("1");
  const [otherId, setOtherId] = useState("");
  const [rpcHttp, setRpcHttp] = useState("");
  const [rpcWs, setRpcWs] = useState("");
  const chainId = choice === OTHER ? Number(otherId) : Number(choice);
  const values: ChainSetup = {
    chainId,
    rpcHttp: rpcHttp.trim(),
    ...(rpcWs.trim() ? { rpcWs: rpcWs.trim() } : {}),
  };
  const key = JSON.stringify(values);
  const [verified, setVerified] = useState<{
    key: string;
    result: ChainVerify;
  } | null>(null);

  const verify = useMutation({
    mutationFn: () => api.verifyChain(values),
    onSuccess: (result) => setVerified({ key, result }),
  });
  const save = useMutation({
    mutationFn: () => api.setChain(values),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await navigate({ to: "/" });
    },
  });
  // Editing a field clears the verification.
  const current = verified?.key === key ? verified.result : null;
  const ready =
    Number.isSafeInteger(chainId) && chainId > 0 && values.rpcHttp !== "";

  return (
    <AuthCard
      title="Chain and RPC"
      hint="The engine watches one chain, through an endpoint of your own. Nothing is saved until it verifies."
      onSubmit={() => current?.ok && !save.isPending && save.mutate()}
    >
      <label className="block">
        <span className={labelClass}>Chain</span>
        <select
          className={fieldClass}
          value={choice}
          disabled={save.isPending}
          onChange={(e) => setChoice(e.target.value)}
        >
          {chains.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name} ({c.id})
            </option>
          ))}
          <option value={OTHER}>Another chain, by id</option>
        </select>
      </label>
      {choice === OTHER && (
        <label className="block">
          <span className={labelClass}>Chain id</span>
          <input
            className={`${fieldClass} font-mono`}
            value={otherId}
            inputMode="numeric"
            disabled={save.isPending}
            onChange={(e) => setOtherId(e.target.value.replace(/\D/g, ""))}
            required
          />
        </label>
      )}
      <label className="block">
        <span className={labelClass}>RPC endpoint (HTTP)</span>
        <input
          className={`${fieldClass} font-mono`}
          value={rpcHttp}
          placeholder="https://… or env:NAME"
          disabled={save.isPending}
          onChange={(e) => setRpcHttp(e.target.value)}
          required
        />
      </label>
      <label className="block">
        <span className={labelClass}>WebSocket endpoint (optional)</span>
        <input
          className={`${fieldClass} font-mono`}
          value={rpcWs}
          placeholder="wss://…, to watch pending transactions"
          disabled={save.isPending}
          onChange={(e) => setRpcWs(e.target.value)}
        />
      </label>

      {current && <VerifyLines result={current} chainId={chainId} />}
      {verify.error && (
        <p className="text-sm text-red-400">{verify.error.message}</p>
      )}
      {save.isPending && <EngineProgress />}
      {save.error && (
        <div className="space-y-2">
          <p className="text-sm whitespace-pre-wrap text-red-400">
            {save.error.message}
          </p>
        </div>
      )}

      <div className="flex gap-3">
        <Button
          variant="ghost"
          className="flex-1"
          disabled={!ready || verify.isPending || save.isPending}
          onClick={() => verify.mutate()}
        >
          {verify.isPending ? "Verifying…" : "Verify"}
        </Button>
        <Button
          type="submit"
          className="flex-1"
          disabled={!current?.ok || save.isPending}
          title={current?.ok ? undefined : "Verify the endpoint first"}
        >
          {save.isPending ? "Starting…" : "Continue"}
        </Button>
      </div>
    </AuthCard>
  );
}

function VerifyLines({
  result,
  chainId,
}: {
  result: ChainVerify;
  chainId: number;
}) {
  const name = chains.find((c) => c.id === chainId)?.name ?? `chain ${chainId}`;
  const wrong = result.problems.find((p) => p.code === "wrong_chain");
  const lines: { ok: boolean; text: string }[] = [
    wrong
      ? { ok: false, text: wrong.message }
      : result.head !== null
        ? { ok: true, text: `The endpoint serves ${name} (${chainId})` }
        : { ok: false, text: "The endpoint could not be checked" },
  ];
  if (result.receipts) {
    lines.push({ ok: true, text: `Receipts: ${result.receipts}` });
  }
  if (result.head !== null) {
    lines.push({
      ok: true,
      text: `Latest block: ${result.head.toLocaleString("en-US")}`,
    });
  }
  if (result.ws) {
    lines.push(
      result.ws.ok && result.ws.pending
        ? { ok: true, text: "Pending transactions: subscribed" }
        : {
            ok: false,
            text: "Pending transactions: the WebSocket did not subscribe",
          },
    );
  }
  for (const p of result.problems) {
    if (p.code !== "wrong_chain") lines.push({ ok: false, text: p.message });
  }
  return (
    <ul className="space-y-1 bg-white/3 px-4 py-3 text-sm">
      {lines.map((line, i) => (
        <li
          key={i}
          className={`flex gap-2 ${line.ok ? "text-gray-300" : "text-red-400"}`}
        >
          <span className={line.ok ? "text-emerald-400" : ""}>
            {line.ok ? "✓" : "✗"}
          </span>
          <span className="wrap-anywhere">{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** The engine's state while it is installed and started, from `GET /engine`. */
function EngineProgress() {
  const { data: engine } = useQuery({
    queryKey: ["engine", "setup"],
    queryFn: ({ signal }) => api.engine(signal),
    refetchInterval: 1000,
  });
  if (!engine) return null;
  const mb = (n: number) => (n / 1_048_576).toFixed(1);
  const version = engine.pinnedVersion ?? engine.version ?? "";
  const words =
    engine.state === "installing" || engine.install
      ? engine.install
        ? `downloading ${mb(engine.install.bytes)}${engine.install.total ? ` of ${mb(engine.install.total)}` : ""} MB`
        : "verifying signature"
      : engine.state === "ready" || engine.state === "degraded"
        ? `${engine.state}${engine.health?.head != null ? ` at block ${engine.health.head.toLocaleString("en-US")}` : ""}`
        : engine.state === "unconfigured"
          ? "starting"
          : engine.state;
  return (
    <p className="bg-white/3 px-4 py-3 font-mono text-xs text-gray-300">
      Engine {version} <span className="text-emerald-400">{words}</span>
      {engine.problem && engine.state !== "ready" && (
        <span className="mt-1 block text-gray-500">
          {engine.problem.message}
        </span>
      )}
    </p>
  );
}
