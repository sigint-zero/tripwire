import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { AppShell } from "./components/AppShell";
import { Scanlines } from "./components/Scanlines";
import { ActivityPage } from "./pages/Activity";
import { ContractsPage } from "./pages/Contracts";
import { FirstRunPage } from "./pages/FirstRun";
import { InvariantsPage } from "./pages/Invariants";
import { NotFoundPage } from "./pages/NotFound";
import { NotificationsPage } from "./pages/Notifications";
import { OverviewPage } from "./pages/Overview";
import { ResponsesPage } from "./pages/Responses";
import { SettingsPage } from "./pages/Settings";
import { ViolationsPage } from "./pages/Violations";

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <Scanlines />
    </>
  ),
  notFoundComponent: NotFoundPage,
});

// Every area except first run shares the navigation shell.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AppShell,
});

const overviewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  component: OverviewPage,
});

const contractsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/contracts",
  component: ContractsPage,
});

const invariantsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/invariants",
  component: InvariantsPage,
});

const violationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/violations",
  component: ViolationsPage,
});

const responsesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/responses",
  component: ResponsesPage,
});

const activityRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/activity",
  component: ActivityPage,
});

const notificationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/notifications",
  component: NotificationsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings",
  component: SettingsPage,
});

const firstRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: FirstRunPage,
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    overviewRoute,
    contractsRoute,
    invariantsRoute,
    violationsRoute,
    responsesRoute,
    activityRoute,
    notificationsRoute,
    settingsRoute,
  ]),
  firstRunRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
