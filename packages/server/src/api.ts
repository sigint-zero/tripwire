import type { FastifyPluginCallback } from "fastify";
import type pg from "pg";
import { AbiLookup, abiRoutes } from "./abi";
import type { Auth } from "./auth";
import { authRoutes, requireSession } from "./auth/routes";
import { contractRoutes } from "./contracts";
import type { EngineBackend } from "./engine";
import { EngineMonitor } from "./engine/monitor";
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
  const lookup = new AbiLookup(info.chainId);
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
    info.simulated ? "stand-in" : "attached",
  );
  const stopMonitor = monitor.start();
  app.addHook("onClose", (_app, done) => {
    stopMonitor();
    done();
  });
  app.get("/engine", () => monitor.status(info));
  app.register(abiRoutes, { lookup });
  app.register(contractRoutes, { commands, reads, store, lookup });
  const rules = new RuleService(commands, reads, store, info.simulated);
  app.register(ruleRoutes, { commands, reads, store, rules });
  app.register(violationRoutes, { reads, store });
  app.register(responseRoutes, { commands, reads });
  app.register(seriesRoutes, { reads });
  app.register(tripStateRoutes, { reads });
  app.register(setupRoutes, { reads, store });
  app.register(readinessRoutes, { commands, reads, info });
  app.register(actionRoutes, { commands, reads });
  app.register(keyRoutes, {
    commands,
    reads,
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
    raiseEngineAlerts(monitor, worker);
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
 * The alerts about the engine that the engine cannot raise itself: it
 * stopped answering, and it came back.
 */
function raiseEngineAlerts(monitor: EngineMonitor, worker: NotificationWorker) {
  let silent = false;
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
      } else if ((state === "ready" || state === "degraded") && silent) {
        silent = false;
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
