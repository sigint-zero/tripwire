import type {
  KeyItem,
  ReadinessStep,
  ReadinessStepName,
  Readiness as ReadinessData,
  ResponseTest,
} from "@tripwire/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "../../lib/api";
import { formatUnits, shortAddress, timeAgo } from "../../lib/format";
import { Copyable } from "../Copyable";
import { Keys } from "../Keys";
import { Button } from "../ui";

/**
 * What happens to this contract when one of its rules trips
 * (`RESPONSES.md`, Readiness). A contract whose rules only alert says so
 * in a line. Once a rule is meant to pause it, the checks become a short
 * guide: each thing Tripwire still needs, in order, with the way to do it
 * right there. It re-reads on every block, so a step ticks by itself once
 * the chain catches up.
 */
export function Readiness({ address }: { address: string }) {
  const { data, error } = useQuery({
    queryKey: ["readiness", address],
    queryFn: ({ signal }) => api.readiness(address, signal),
  });
  const { data: keys } = useQuery({
    queryKey: ["keys"],
    queryFn: ({ signal }) => api.keys(signal),
  });

  if (error) {
    return (
      <p className="bg-white/2 px-5 py-4 text-sm text-gray-500">
        Cannot check this now: {error.message}
      </p>
    );
  }
  if (!data) return <div className="h-24 bg-white/2" />;

  const step = (name: ReadinessStepName) =>
    data.steps.find((s) => s.step === name);

  // Nothing is meant to act: alerts are the whole story, and that is fine.
  if (data.rules.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white/2 px-5 py-4">
        <p className="text-sm text-gray-400">
          <span className="text-gray-200">You are alerted.</span> None of this
          contract&apos;s rules pauses it; Tripwire can do that for you when one
          trips.
        </p>
        <Link
          to="/rules/new"
          search={{ contract: address }}
          className="shrink-0 text-[10px] font-bold tracking-[0.2em] text-gray-400 uppercase transition-colors hover:text-emerald-400"
        >
          Make a rule pause it →
        </Link>
      </div>
    );
  }

  const signer = keys?.keys.find((k) => k.signing) ?? null;
  const guide: Item[] = [
    walletItem(step("signing_key"), signer, keys?.keys.length ?? 0),
  ];
  const registered = step("registered");
  if (registered) {
    guide.push({
      done: registered.state === "done",
      title: `${data.name} is registered with the controller`,
      body:
        registered.state === "done" ? null : (
          <p>
            A contract registers itself with the controller, from its own code.
            Rules that call {data.name}&apos;s own functions need none of this.
          </p>
        ),
    });
  }
  const operator = step("operator");
  if (operator) {
    guide.push({
      done: operator.state === "done",
      title: "Tripwire's wallet may pause it through the controller",
      body:
        operator.state === "done" ? null : data.guardianCall ? (
          <>
            <p>
              The guardian names Tripwire&apos;s wallet an operator, once. Send
              this from the guardian&apos;s wallet; this step ticks by itself
              when it lands.
            </p>
            <div className="mt-3">
              <Copyable label="From" value={data.guardianCall.from} />
              <Copyable label="To" value={data.guardianCall.to} />
              <Copyable label="Data" value={data.guardianCall.data} />
            </div>
          </>
        ) : (
          <p>First give Tripwire a wallet, and register {data.name}.</p>
        ),
    });
  }
  const permission = step("permission");
  guide.push({
    done: permission?.state === "done",
    title: `Each pause would go through`,
    body: (
      <>
        <p>
          {permission?.state === "done"
            ? "Tested from Tripwire's wallet. Nothing was sent."
            : "A test builds each rule's pause from Tripwire's wallet and simulates it. Nothing is sent."}
        </p>
        <ul className="mt-3 space-y-1">
          {data.rules.map((rule) => (
            <TestRow key={rule.id} address={data.address} rule={rule} />
          ))}
        </ul>
      </>
    ),
  });

  const left = guide.filter((item) => !item.done).length;
  const acting =
    data.rules.length === 1
      ? data.rules[0]!.name
      : `any of ${data.rules.length} rules`;
  const leastPower = step("least_power");
  const mode = step("mode");

  return (
    <div className="space-y-4">
      <p className="text-sm">
        {left === 0 ? (
          <span className="text-emerald-400">
            Tripwire will pause {data.name} when {acting} trips.
          </span>
        ) : (
          <span className="text-gray-200">
            Tripwire cannot pause {data.name} yet: {left}{" "}
            {left === 1 ? "thing" : "things"} left.
          </span>
        )}{" "}
        <span className="text-gray-500">{modeSentence(mode)}</span>
      </p>

      <ol className="space-y-1">
        {guide.map((item, i) => (
          <GuideItem
            key={item.title}
            n={i + 1}
            item={item}
            current={!item.done && guide.findIndex((g) => !g.done) === i}
          />
        ))}
      </ol>

      {leastPower?.state === "todo" && (
        <p className="bg-amber-400/6 px-5 py-4 text-sm text-amber-200">
          Worth changing: {leastPower.detail}
        </p>
      )}
    </div>
  );
}

interface Item {
  done: boolean;
  title: string;
  body: ReactNode;
}

function GuideItem({
  n,
  item,
  current,
}: {
  n: number;
  item: Item;
  current: boolean;
}) {
  return (
    <li
      className={`flex gap-4 px-5 py-4 ${current ? "bg-white/4" : "bg-white/2"}`}
    >
      <span
        aria-label={item.done ? "done" : "to do"}
        className={`flex size-6 shrink-0 items-center justify-center font-mono text-xs ${
          item.done
            ? "bg-emerald-500/15 text-emerald-400"
            : current
              ? "bg-white/10 text-white"
              : "bg-white/5 text-gray-500"
        }`}
      >
        {item.done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={`text-sm ${item.done ? "text-gray-400" : current ? "text-white" : "text-gray-400"}`}
        >
          {item.title}
        </p>
        {item.body && (current || item.done) && (
          <div className="mt-2 text-sm text-gray-400">{item.body}</div>
        )}
      </div>
    </li>
  );
}

/** Step one: a wallet of Tripwire's own, unlocked and funded, set up right here. */
function walletItem(
  step: ReadinessStep | undefined,
  signer: KeyItem | null,
  count: number,
): Item {
  const done = step?.state === "done";
  const title = "A wallet for Tripwire to send from";
  if (done && signer) {
    return {
      done,
      title,
      body: (
        <p>
          <span className="font-mono">{shortAddress(signer.address)}</span>,
          holding {formatUnits(signer.balanceWei ?? "0", 18)} ETH.
        </p>
      ),
    };
  }
  const why =
    count === 0 ? (
      "Tripwire needs a wallet of its own to send the pause from. Its key stays on this machine."
    ) : !signer ? (
      "Several wallets exist; the engine's configuration must name the one that sends."
    ) : !signer.unlocked ? (
      <>
        <span className="font-mono">{shortAddress(signer.address)}</span> is
        locked. Unlock it with its passphrase.
      </>
    ) : (
      <>
        <span className="font-mono">{shortAddress(signer.address)}</span> has no
        ETH to pay for gas. Send it a little:
      </>
    );
  return {
    done,
    title,
    body: (
      <>
        <p>{why}</p>
        {signer && signer.unlocked && signer.balanceWei === "0" ? (
          <div className="mt-3">
            <Copyable label="Address" value={signer.address} />
          </div>
        ) : (
          <div className="mt-4">
            <Keys />
          </div>
        )}
      </>
    ),
  };
}

function modeSentence(mode: ReadinessStep | undefined): string {
  if (!mode) return "";
  if (mode.state === "todo") {
    return "Right now Tripwire only alerts: its response mode is notify, so nothing is built or sent.";
  }
  return mode.detail.includes("approval")
    ? "Each pause waits for someone to approve it in Responses."
    : "Pauses are sent the moment a rule trips.";
}

function TestRow({
  address,
  rule,
}: {
  address: string;
  rule: ReadinessData["rules"][number];
}) {
  const queryClient = useQueryClient();
  const test = useMutation({
    mutationFn: () => api.testResponse(rule.id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["readiness", address] }),
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 bg-black/20 px-4 py-2.5">
      <span className="min-w-0">
        <Link
          to="/rules/$id"
          params={{ id: rule.id }}
          className="text-sm text-white transition-colors hover:text-emerald-400"
        >
          {rule.name}
        </Link>
        {rule.test && <TestResult result={rule.test} />}
        {test.error && (
          <span className="block text-xs text-red-400">
            {test.error.message}
          </span>
        )}
      </span>
      <Button
        variant="ghost"
        disabled={test.isPending}
        onClick={() => test.mutate()}
      >
        {test.isPending ? "Testing…" : rule.test ? "Test again" : "Test it"}
      </Button>
    </li>
  );
}

function TestResult({ result }: { result: ResponseTest }) {
  return (
    <span
      className={`mt-0.5 block text-xs ${result.ok ? "text-gray-400" : "text-red-400"}`}
      title={`Tested ${new Date(result.testedAt).toLocaleString()}`}
    >
      {result.ok
        ? `Would go through${result.gasEstimate !== null ? `, for about ${result.gasEstimate.toLocaleString("en-US")} gas` : ""}. ${timeAgo(result.testedAt)}.`
        : `Would fail: ${result.revertReason ?? "the call reverts"}. Give Tripwire's wallet the permission to make this call.`}
    </span>
  );
}
