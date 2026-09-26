import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
  CHAIN_DEFAULTS,
  ConfigError,
  defaultConfig,
  loadConfig,
  maskUrls,
  parseConfig,
  type ChainConfig,
} from "./config";
import type { EngineInfo } from "@tripwire/shared";
import type { EngineMonitor } from "./engine/monitor";
import {
  SettingsBusy,
  SettingsRejected,
  type EngineSupervisor,
} from "./engine/supervisor";
import { refuse } from "./refuse";

// The engine as the application runs it (`ENGINE.md`, API) and first run's
// chain step (`FIRST-RUN.md`, API). Attached engines and the stand-in have
// nothing here to restart or configure.

const endpoint = z.string().trim().min(1).max(2000);
const chainBody = z.object({
  chainId: z.number().int().positive(),
  rpcHttp: endpoint,
  rpcWs: endpoint.nullable().optional(),
});

function nothingToRun(
  runner: "attached" | "stand-in",
): [number, string, string] {
  return runner === "attached"
    ? [
        409,
        "engine_attached",
        "The engine was started by hand; Tripwire does not restart or configure it.",
      ]
    : [409, "engine_stand_in", "The stand-in answers instead of an engine."];
}

export const engineRoutes: FastifyPluginCallback<{
  supervisor: EngineSupervisor | null;
  monitor: EngineMonitor;
  info: EngineInfo;
}> = (app, { supervisor, monitor, info }, done) => {
  const runner = info.simulated ? "stand-in" : "attached";

  app.post("/engine/restart", async (request, reply) => {
    if (!supervisor) return refuse(reply, ...nothingToRun(runner));
    const by = request.account?.username ?? "someone";
    try {
      await supervisor.restart(by);
    } catch (error) {
      if (error instanceof SettingsRejected) {
        return refuse(reply, 409, "engine_unconfigured", error.message);
      }
      throw error;
    }
    request.log.info({ by }, "engine restart");
    return monitor.status(info);
  });

  app.get<{ Querystring: { lines?: string } }>(
    "/engine/log",
    async (request, reply) => {
      if (!supervisor) return refuse(reply, ...nothingToRun(runner));
      const lines = Math.min(
        1000,
        Math.max(1, Number(request.query.lines ?? 200) || 200),
      );
      return { lines: supervisor.log.lines(lines) };
    },
  );

  app.post("/setup/chain/verify", async (request, reply) => {
    if (!supervisor) return refuse(reply, ...nothingToRun(runner));
    const body = chainBody.safeParse(request.body ?? {});
    if (!body.success) {
      return refuse(reply, 400, "invalid_settings", "Invalid chain settings.");
    }
    const chain = toChain(body.data);
    if (chain instanceof ConfigError) {
      return refuse(reply, 400, "invalid_settings", chain.message);
    }
    try {
      return await supervisor.verify(chain);
    } catch (error) {
      return refuse(
        reply,
        409,
        "engine_unavailable",
        maskUrls(error instanceof Error ? error.message : String(error)),
      );
    }
  });

  app.put("/setup/chain", async (request, reply) => {
    if (!supervisor) return refuse(reply, ...nothingToRun(runner));
    const body = chainBody.safeParse(request.body ?? {});
    if (!body.success) {
      return refuse(reply, 400, "invalid_settings", "Invalid chain settings.");
    }
    const current = await loadConfig(supervisor.home).catch(() =>
      defaultConfig(),
    );
    if (current.chain) {
      return refuse(
        reply,
        409,
        "already_configured",
        "A chain is already configured; change it in Settings.",
      );
    }
    const chain = toChain(body.data);
    if (chain instanceof ConfigError) {
      return refuse(reply, 400, "invalid_settings", chain.message);
    }
    let verified;
    try {
      verified = await supervisor.verify(chain);
    } catch (error) {
      return refuse(
        reply,
        409,
        "settings_rejected",
        maskUrls(error instanceof Error ? error.message : String(error)),
      );
    }
    if (!verified.ok) {
      return refuse(
        reply,
        409,
        "settings_rejected",
        verified.problems.map((p) => p.message).join(" ") ||
          "The endpoint did not verify.",
        { verify: verified },
      );
    }
    try {
      await supervisor.apply(
        {
          ...current,
          chain,
          mempool: { enabled: Boolean(chain.rpcWs), respond: false },
        },
        () => monitor.watching,
      );
    } catch (error) {
      if (error instanceof SettingsBusy) {
        return refuse(reply, 409, "settings_busy", error.message);
      }
      if (error instanceof SettingsRejected) {
        return refuse(reply, 409, "settings_rejected", error.message);
      }
      if (error instanceof ConfigError) {
        return refuse(reply, 400, "invalid_settings", error.message);
      }
      throw error;
    }
    request.log.info(
      { by: request.account?.username, chainId: chain.chainId },
      "chain configured",
    );
    return { applied: true };
  });

  done();
};

/** The chain as the file would hold it, by the file's own rules. */
function toChain(body: z.infer<typeof chainBody>): ChainConfig | ConfigError {
  try {
    return parseConfig({
      version: 1,
      chain: {
        ...CHAIN_DEFAULTS,
        chainId: body.chainId,
        rpcHttp: body.rpcHttp,
        rpcWs: body.rpcWs ?? null,
      },
    }).chain!;
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
}
