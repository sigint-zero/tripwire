import type {
  EngineInfo,
  GuardianCall,
  Readiness,
  ReadinessStep,
  ResponseTest,
} from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import { encodeFunctionData, parseAbi } from "viem";
import type {
  ContractRow,
  EngineCommands,
  EngineReads,
  KeyRow,
  RuleRow,
} from "./engine/types";
import { refuse } from "./refuse";

// Whether each contract's responses would work when a rule trips
// (`RESPONSES.md`, Readiness), computed from the keys, the configuration,
// the rules and the controller's mirrored events. Each rule's last test is
// kept in memory until the next test or a restart.

const ADD_OPERATOR = parseAbi(["function addOperator(address,address)"]);
const DEFAULT_ADMIN_ROLE = `0x${"0".repeat(64)}`;

const short = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Whether the ABI has a view function of exactly this shape. */
function hasView(abi: unknown[] | null, name: string, inputs: string[]) {
  return (abi ?? []).some((item) => {
    const f = item as {
      type?: string;
      name?: string;
      inputs?: { type: string }[];
    };
    return (
      f.type === "function" &&
      f.name === name &&
      (f.inputs ?? []).map((i) => i.type).join(",") === inputs.join(",")
    );
  });
}

const actsOnChain = (rule: RuleRow) =>
  rule.enabled && rule.document.on_trip.action !== "notify";
const usesController = (rule: RuleRow) =>
  rule.document.on_trip.action === "trip_global" ||
  rule.document.on_trip.action === "trip_function";

export const readinessRoutes: FastifyPluginCallback<{
  commands: EngineCommands;
  reads: EngineReads;
  info: EngineInfo;
}> = (app, { commands, reads, info }, done) => {
  const tests = new Map<string, ResponseTest>();

  /**
   * The key responses are signed with: the only one, or the one the
   * engine last tested with when there are several.
   */
  const signingKey = (keys: KeyRow[]): KeyRow | null => {
    if (keys.length === 1) return keys[0]!;
    const tested = [...tests.values()]
      .filter((t) => t.sender)
      .sort((a, b) => b.testedAt.localeCompare(a.testedAt))[0];
    return keys.find((k) => k.address === tested?.sender) ?? null;
  };

  /** The least-power check: whether the key could do more than pause. */
  async function leastPower(
    contract: ContractRow,
    key: KeyRow | null,
  ): Promise<ReadinessStep> {
    const step = "least_power";
    if (!key) {
      return { step, state: "not_applicable", detail: "No signing key yet." };
    }
    const owner = hasView(contract.abi, "owner", []);
    const roles = hasView(contract.abi, "hasRole", ["bytes32", "address"]);
    if (!owner && !roles) {
      return {
        step,
        state: "not_applicable",
        detail: "The contract has no owner() or roles to check.",
      };
    }
    const [ownerValue, adminValue] = await commands
      .read([
        ...(owner
          ? [
              {
                address: contract.address,
                function: "owner() returns (address)",
                args: [],
              },
            ]
          : []),
        ...(roles
          ? [
              {
                address: contract.address,
                function: "hasRole(bytes32,address) returns (bool)",
                args: [DEFAULT_ADMIN_ROLE, key.address],
              },
            ]
          : []),
      ])
      .then((values) => (owner ? values : [null, ...values]))
      .catch(() => [null, null]);
    const grant =
      "Grant it only the right to pause, and keep ownership elsewhere.";
    if (
      typeof ownerValue === "string" &&
      ownerValue.toLowerCase() === key.address
    ) {
      return {
        step,
        state: "todo",
        detail: `${short(key.address)} is the contract's owner: it could also upgrade it, change its settings or move funds. ${grant}`,
      };
    }
    if (adminValue === "true") {
      return {
        step,
        state: "todo",
        detail: `${short(key.address)} holds the admin role: it could also grant itself anything. ${grant}`,
      };
    }
    return {
      step,
      state: "done",
      detail: "The key is neither the owner nor an admin.",
    };
  }

  app.get<{ Querystring: { contract?: string } }>(
    "/readiness",
    async (request): Promise<Readiness[]> => {
      const wanted = request.query.contract?.toLowerCase();
      const [contracts, rules, keys, registrations, operators, health] =
        await Promise.all([
          reads.contracts(),
          reads.rules(),
          commands.keys(),
          reads.registrations(),
          reads.operators(),
          commands.health().catch(() => null),
        ]);
      const key = signingKey(keys);
      const controller = health?.controller?.address ?? null;

      return Promise.all(
        contracts
          .filter((c) => !wanted || c.address.toLowerCase() === wanted)
          .map(async (contract): Promise<Readiness> => {
            const address = contract.address.toLowerCase();
            const acting = rules.filter(
              (r) => r.contract_id === contract.id && actsOnChain(r),
            );
            const onController = acting.some(usesController);
            const guardian = registrations.find(
              (r) => r.contract_address.toLowerCase() === address,
            )?.guardian;
            const operator =
              key !== null &&
              operators.some(
                (o) =>
                  o.contract_address.toLowerCase() === address &&
                  o.operator === key.address,
              );
            const steps: ReadinessStep[] = [];

            steps.push(
              keys.length === 0
                ? {
                    step: "signing_key",
                    state: "todo",
                    detail:
                      "No key yet. Create or import one in Settings, Keys.",
                  }
                : !key
                  ? {
                      step: "signing_key",
                      state: "todo",
                      detail: `${keys.length} keys: the engine's [response] key must name the one that signs.`,
                    }
                  : !key.unlocked
                    ? {
                        step: "signing_key",
                        state: "todo",
                        detail: `${short(key.address)} is locked. Unlock it in Settings, Keys.`,
                      }
                    : key.balance === "0"
                      ? {
                          step: "signing_key",
                          state: "todo",
                          detail: `${short(key.address)} has no funds for gas.`,
                        }
                      : {
                          step: "signing_key",
                          state: "done",
                          detail: `Signs as ${short(key.address)}.`,
                        },
            );
            steps.push(
              acting.length > 0
                ? {
                    step: "rules",
                    state: "done",
                    detail: `${acting.length} enabled ${acting.length === 1 ? "rule acts" : "rules act"} on chain.`,
                  }
                : {
                    step: "rules",
                    state: "todo",
                    detail:
                      "No enabled rule acts on chain. Give one a pause or a call as its response.",
                  },
            );

            let guardianCall: GuardianCall | null = null;
            if (onController) {
              steps.push(
                guardian
                  ? {
                      step: "registered",
                      state: "done",
                      detail: `Registered with the controller; guardian ${short(guardian)}.`,
                    }
                  : {
                      step: "registered",
                      state: "todo",
                      detail:
                        "Not registered with the controller. A contract registers itself, in its constructor or an upgrade; rules that call its own functions need none.",
                    },
              );
              if (!key || !guardian) {
                steps.push({
                  step: "operator",
                  state: "not_applicable",
                  detail: "Needs a signing key and a registration first.",
                });
              } else if (operator) {
                steps.push({
                  step: "operator",
                  state: "done",
                  detail: `${short(key.address)} is an operator on the controller.`,
                });
              } else {
                steps.push({
                  step: "operator",
                  state: "todo",
                  detail: `The guardian must name ${short(key.address)} an operator.`,
                });
                if (controller) {
                  guardianCall = {
                    to: controller,
                    value: "0",
                    data: encodeFunctionData({
                      abi: ADD_OPERATOR,
                      args: [
                        address as `0x${string}`,
                        key.address as `0x${string}`,
                      ],
                    }),
                    from: guardian,
                  };
                }
              }
            }

            const results = acting.map((r) => tests.get(r.id));
            const failed = acting.find((r) => tests.get(r.id)?.ok === false);
            steps.push(
              acting.length === 0
                ? {
                    step: "permission",
                    state: "not_applicable",
                    detail: "No rule to test.",
                  }
                : failed
                  ? {
                      step: "permission",
                      state: "todo",
                      detail: `${failed.name}: ${tests.get(failed.id)?.revertReason ?? "the call would revert"}.`,
                    }
                  : results.every((t) => t?.ok)
                    ? {
                        step: "permission",
                        state: "done",
                        detail:
                          acting.length === 1
                            ? "The response passed its test."
                            : "Every response passed its test.",
                      }
                    : {
                        step: "permission",
                        state: "todo",
                        detail: "Test each rule's response.",
                      },
            );
            steps.push(await leastPower(contract, key));
            steps.push(
              info.responseMode === "notify"
                ? {
                    step: "mode",
                    state: "todo",
                    detail:
                      "The mode is notify: violations alert and nothing is built.",
                  }
                : {
                    step: "mode",
                    state: "done",
                    detail:
                      info.responseMode === "prepare"
                        ? "Responses wait for your approval."
                        : "Responses are sent at once.",
                  },
            );

            return {
              address: contract.address,
              name: contract.name,
              steps,
              guardianCall,
              rules: acting.map((r) => ({
                id: r.id,
                name: r.name,
                action: r.document.on_trip
                  .action as Readiness["rules"][number]["action"],
                test: tests.get(r.id) ?? null,
              })),
            };
          }),
      );
    },
  );

  app.post<{ Params: { ruleId: string } }>(
    "/readiness/:ruleId/test",
    async (request, reply) => {
      const { ruleId } = request.params;
      if (!/^\d+$/.test(ruleId) || !(await reads.rule(ruleId))) {
        return refuse(reply, 404, "not_found", "No such rule.");
      }
      const run = await commands.responseDryRun(ruleId);
      const sender = run.preview.sender?.toLowerCase() ?? null;
      const keys = sender ? await commands.keys().catch(() => []) : [];
      const test: ResponseTest = {
        ok: run.ok,
        revertReason: run.revert_reason ?? null,
        gasEstimate: run.gas_estimate ?? null,
        sender,
        balanceWei: keys.find((k) => k.address === sender)?.balance ?? null,
        function: run.preview.function ?? null,
        args: run.preview.decoded_args ?? [],
        testedAt: new Date().toISOString(),
      };
      tests.set(ruleId, test);
      return test;
    },
  );

  done();
};
