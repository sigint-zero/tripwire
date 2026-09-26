import type { FastifyPluginCallback } from "fastify";
import type pg from "pg";
import { AbiLookup, abiRoutes } from "./abi";
import type { Auth } from "./auth";
import { authRoutes, requireSession } from "./auth/routes";
import { contractRoutes } from "./contracts";
import type { EngineBackend } from "./engine";
import { EngineMonitor } from "./engine/monitor";
import type { EngineSupervisor } from "./engine/supervisor";
import { engineRoutes } from "./engine-routes";
import { EngineError, EngineNotReady } from "./engine/types";
import { BrowserRelay } from "./events/relay";
import type { EngineEvents } from "./events/types";
import { actionRoutes } from "./actions";
import { eventRoutes } from "./events/route";
import { keyRoutes } from "./keys";
import { notificationRoutes } from "./notifications/routes";
import { ChannelSecrets } from "./notifications/secrets";
import { NotificationStore } from "./notifications/store";
import { NotificationWorker } from "./notifications/worker";
import { refuse } from "./refuse";
import { responseRoutes } from "./responses";
import { seriesRoutes } from "./series";
import { setupRoutes } from "./setup";
import { RuleService } from "./rule-service";
import { readinessRoutes } from "./readiness";
import { ruleRoutes } from "./rules";
import { AppStore } from "./store";
import { tripStateRoutes } from "./trip-state";
import { violationRoutes } from "./violations";

/** What the API serves from: the shared database and the engine. */
export interface Backend {
  pool: pg.Pool;
  engine: EngineBackend;
}

export const api: FastifyPluginCallback<{
  backend?: Backend;
  auth?: Auth;
  /** The data directory, where channel secrets are kept beside the accounts. */
  home?: string;
}> = (app, { backend, auth, home }, done) => {
  // Every route below needs a session, except health and logging in.
  if (auth) {
    requireSession(app, auth);
    app.register(authRoutes, { auth });
  }
  app.get("/health", () => ({ status: "ok" }));
  if (!backend) return done();

  const { commands, reads, info } = backend.engine;
  const store = new AppStore(backend.pool);
  // First run may set the chain after the server has started.
  const lookup = new AbiLookup(() => info.chainId);
  const supervisor = backend.engine.supervisor ?? null;
  app.addHook("onClose", () => backend.engine.close());

  // The engine's refusals keep their status and code; until the engine has
  // created its views, reads answer that it is still starting.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof EngineError) {
      return refuse(reply, error.status, error.code, error.message, {
        ...(error.issues ? { issues: error.issues } : {}),
      });
    }
    if (error instanceof EngineNotReady) {
      return refuse(reply, 503, "engine_starting", error.message);
    }
    return reply.send(error);
  });

  const monitor = new EngineMonitor(
    commands,
    reads,
    supervisor ? "supervised" : info.simulated ? "stand-in" : "attached",
    Date.now,
    supervisor,
  );
  const stopMonitor = monitor.start();
  app.addHook("onClose", (_app, done) => {
    stopMonitor();
    done();
  });
  app.get("/engine", () => monitor.status(info));
  app.register(engineRoutes, { supervisor, monitor, info });
  app.register(abiRoutes, { lookup });
  app.register(contractRoutes, { commands, reads, store, lookup });
  const rules = new RuleService(commands, reads, store, info.simulated);
  app.register(ruleRoutes, { commands, reads, store, rules });
  app.register(violationRoutes, { reads, store });
  app.register(responseRoutes, { commands, reads });
  app.register(seriesRoutes, { reads });
  app.register(tripStateRoutes, { reads });
  app.register(setupRoutes, {
    reads,
    store,
    // An attached engine or the stand-in has its chain already.
    chainConfigured: () => !supervisor || supervisor.config?.chain != null,
  });
  app.register(readinessRoutes, { commands, reads, info });
  app.register(actionRoutes, { commands, reads });
  app.register(keyRoutes, {
    commands,
    reads,
    store,
    signingKey: () => supervisor?.config?.response.key ?? null,
    responseMode: () => info.responseMode,
    directory: backend.engine.keysDirectory ?? null,
  });
  if (auth && home) {
    const notifications = new NotificationStore(backend.pool, reads.views);
    const secrets = new ChannelSecrets(home);
    const worker = new NotificationWorker({
      store: notifications,
      secrets,
      reads,
      events: backend.engine.events,
      watching: () => monitor.watching,
      log: (message, detail) => app.log.warn(detail, message),
    });
    const stopWorker = worker.start();
    app.addHook("onClose", () => stopWorker());
    raiseEngineAlerts(monitor, worker, supervisor);
    app.register(notificationRoutes, {
      store: notifications,
      secrets,
      reads,
      worker,
    });

    // The engine's own events, the monitor's word on whether it runs, and
    // the application's own notifications.
    const events: EngineEvents = {
      listen: (listener) => {
        const stops = [
          backend.engine.events.listen(listener),
          monitor.listen(listener),
          worker.listen(listener),
        ];
        return () => stops.forEach((stop) => stop());
      },
    };
    const relay = new BrowserRelay(events, (message, detail) =>
      app.log.warn(detail, message),
    );
    // Open streams would hold the server's close; they end first.
    app.addHook("preClose", (done) => {
      relay.close();
      done();
    });
    app.register(eventRoutes, { relay, auth });
  }

  done();
};

/**
 * The alerts about the engine that the engine cannot raise itself
 * (`NOTIFICATIONS.md`): it stopped, keeps restarting, cannot start, or
 * stopped answering; and that it came back.
 */
function raiseEngineAlerts(
  monitor: EngineMonitor,
  worker: NotificationWorker,
  supervisor: EngineSupervisor | null,
) {
  let silent = false;
  let troubled = false;
  supervisor?.listen({
    alert: (alert) => {
      troubled = true;
      const title = {
        stopped: "Engine stopped",
        repeated: "Engine restarting repeatedly",
        cannot_start: "Engine cannot start",
      }[alert.kind];
      void worker.raise("critical", title, alert.message);
    },
  });
  monitor.listen({
    event: ({ event, data }) => {
      if (event !== "health") return;
      const state = (data as { status?: string }).status;
      if (state === "unresponsive" && !silent) {
        silent = true;
        void worker.raise(
          "critical",
          "Engine not responding",
          "The engine has not answered its health check for a minute. Nothing is being watched until it does.",
        );
      } else if (state === "ready" && (silent || troubled)) {
        silent = false;
        troubled = false;
        void worker.raise(
          "info",
          "Engine recovered",
          "Tripwire is watching again.",
        );
      }
    },
    resync: () => {},
  });
}
