import type { SetupState } from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import type { EngineReads } from "./engine/types";
import type { AppStore } from "./store";

// First-run progress (`FIRST-RUN.md`), derived from state, with only the
// dismissal stored. The dashboard is reachable only with an account, so
// that step is done by the time anyone asks.

const DISMISSED = "setup.dismissed";

export const setupRoutes: FastifyPluginCallback<{
  reads: EngineReads;
  store: AppStore;
  chainConfigured: () => boolean;
}> = (app, { reads, store, chainConfigured }, done) => {
  app.get("/setup", async (): Promise<SetupState> => {
    const chain = chainConfigured();
    // With no chain yet the engine has made no views to read.
    const [contracts, rules, channels, dismissed] = await Promise.all([
      chain ? reads.contracts().catch(() => []) : [],
      chain ? reads.rules().catch(() => []) : [],
      store.channelCount(),
      store.setting<unknown>(DISMISSED, false),
    ]);
    return {
      steps: {
        account: true,
        chain,
        contract: contracts.length > 0,
        rule: rules.length > 0,
        channel: channels > 0,
      },
      dismissed: dismissed === true,
    };
  });

  // Remembered for every account.
  app.post("/setup/dismiss", async (): Promise<{ dismissed: true }> => {
    await store.setSetting(DISMISSED, true);
    return { dismissed: true };
  });
  done();
};
