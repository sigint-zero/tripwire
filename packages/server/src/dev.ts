import middie from "@fastify/middie";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";
import { createServer } from "./app";

// Development entry: the API and the dashboard (with hot reload) on one port.
const webRoot = fileURLToPath(new URL("../../web", import.meta.url));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 5173);

const app = await createServer();

const vite = await createVite({
  root: webRoot,
  configFile: `${webRoot}/vite.config.ts`,
  appType: "spa",
  server: { middlewareMode: true, hmr: { server: app.server } },
});
await app.register(middie);
app.use((req, res, next) =>
  req.url?.startsWith("/api/") ? next() : vite.middlewares(req, res, next),
);
app.addHook("onClose", () => vite.close());

await app.listen({ host, port });
console.log(`Tripwire dev server: http://${host}:${port}`);
