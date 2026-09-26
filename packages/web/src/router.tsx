import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { auth, isLoggedOut } from "./lib/api";
import { useLiveUpdates } from "./lib/live";
import { AppShell } from "./components/AppShell";
import { Scanlines } from "./components/Scanlines";
import { ActivityPage } from "./pages/Activity";
import { ContractPage } from "./pages/Contract";
import { ContractsPage } from "./pages/Contracts";
import { EditRulePage } from "./pages/EditRule";
import { FirstRunPage } from "./pages/FirstRun";
import { LoginPage } from "./pages/Login";
import { NewRulePage } from "./pages/NewRule";
import { NotFoundPage } from "./pages/NotFound";
import { NotificationsPage } from "./pages/Notifications";
import { OverviewPage } from "./pages/Overview";
import { readResponsesSearch, ResponsesPage } from "./pages/Responses";
import { RulePage } from "./pages/Rule";
import { RulesPage } from "./pages/Rules";
import { SettingsPage } from "./pages/Settings";
import { readFilter, ViolationsPage } from "./pages/Violations";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <>
      <Outlet />
      <Scanlines />
    </>
  ),
  notFoundComponent: NotFoundPage,
});

const setupQuery = {
  queryKey: ["auth", "setup"],
  queryFn: ({ signal }: { signal: AbortSignal }) => auth.setup(signal),
};
const sessionQuery = {
  queryKey: ["auth", "session"],
  queryFn: ({ signal }: { signal: AbortSignal }) => auth.session(signal),
};

/** Only a path on this site is followed back after logging in. */
const safeRedirect = (value: unknown): string | undefined =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : undefined;

// Every area except login and first run shares the navigation shell, and
// needs a session: a fresh installation goes to first run, anyone else
// logged out to the login page.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: function Shell() {
    useLiveUpdates();
    return <AppShell />;
  },
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const setup = await queryClient.fetchQuery(setupQuery);
    if (setup.required) throw redirect({ to: "/setup" });
    try {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 60_000 });
    } catch (error) {
      if (!isLoggedOut(error)) throw error;
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
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

const contractRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/contracts/$address",
  component: function Contract() {
    const { address } = contractRoute.useParams();
    return <ContractPage key={address} address={address} />;
  },
});

const rulesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/rules",
  validateSearch: (search): { created?: string } =>
    typeof search.created === "string" ? { created: search.created } : {},
  component: function Rules() {
    const { created } = rulesRoute.useSearch();
    return <RulesPage created={created} />;
  },
});

const newRuleRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/rules/new",
  validateSearch: (search): { contract?: string } =>
    typeof search.contract === "string" ? { contract: search.contract } : {},
  component: function NewRule() {
    const { contract } = newRuleRoute.useSearch();
    return <NewRulePage key={contract} contract={contract} />;
  },
});

const ruleRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/rules/$id",
  component: function Rule() {
    const { id } = ruleRoute.useParams();
    return <RulePage key={id} id={id} />;
  },
});

const editRuleRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/rules/$id/edit",
  component: function EditRule() {
    const { id } = editRuleRoute.useParams();
    return <EditRulePage key={id} id={id} />;
  },
});

const violationsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/violations",
  validateSearch: readFilter,
  component: function Violations() {
    const filter = violationsRoute.useSearch();
    const navigate = violationsRoute.useNavigate();
    return (
      <ViolationsPage
        filter={filter}
        onFilter={(search) => void navigate({ search, replace: true })}
      />
    );
  },
});

const responsesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/responses",
  validateSearch: readResponsesSearch,
  component: function Responses() {
    const search = responsesRoute.useSearch();
    const navigate = responsesRoute.useNavigate();
    return (
      <ResponsesPage
        search={search}
        onSearch={(next) => void navigate({ search: next, replace: true })}
      />
    );
  },
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
  beforeLoad: async ({ context: { queryClient } }) => {
    const setup = await queryClient.fetchQuery(setupQuery);
    if (!setup.required) throw redirect({ to: "/login" });
  },
  component: FirstRunPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search): { redirect?: string } => {
    const to = safeRedirect(search.redirect);
    return to ? { redirect: to } : {};
  },
  component: function Login() {
    const { redirect: to } = loginRoute.useSearch();
    return <LoginPage redirect={to} />;
  },
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    overviewRoute,
    contractsRoute,
    contractRoute,
    rulesRoute,
    newRuleRoute,
    ruleRoute,
    editRuleRoute,
    violationsRoute,
    responsesRoute,
    activityRoute,
    notificationsRoute,
    settingsRoute,
  ]),
  firstRunRoute,
  loginRoute,
]);

export const router = createRouter({
  routeTree,
  // Supplied by RouterProvider.
  context: { queryClient: undefined! },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
