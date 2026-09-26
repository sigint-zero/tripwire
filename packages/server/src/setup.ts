import type { SetupState } from "@tripwire/shared";
import type { FastifyPluginCallback } from "fastify";
import type { EngineReads } from "./engine/types";
import type { AppStore } from "./store";

// First-run progress (`FIRST-RUN.md`), derived from state, with only the
// dismissal stored. The dashboard is reachable only with an account and a
// chain, so both are done by the time anyone asks.

const DISMISSED = "setup.dismissed";

export const setupRoutes: FastifyPluginCallback<{
  reads: EngineReads;
  store: AppStore;
}> = (app, { reads, store }, done) => {
  app.get("/setup", async (): Promise<SetupState> => {
    const [contracts, rules, channels, dismissed] = await Promise.all([
      reads.contracts(),
      reads.rules(),
      store.channelCount(),
      store.setting<unknown>(DISMISSED, false),
    ]);
    return {
      steps: {
        account: true,
        chain: true,
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
