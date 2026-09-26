import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isLoggedOut } from "./lib/api";
import { router } from "./router";
import "./styles.css";

// Any request refused for want of a session ends what the dashboard knows
// and returns to the login page, which brings the person back afterwards.
const loggedOut = (error: unknown) => {
  if (!isLoggedOut(error) || router.state.location.pathname === "/login") {
    return;
  }
  queryClient.clear();
  void router.navigate({
    to: "/login",
    search: { redirect: router.state.location.href },
  });
};

// The server runs on this machine, so the browser's online status is
// irrelevant: keep querying even when the network is down.
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: loggedOut }),
  mutationCache: new MutationCache({ onError: loggedOut }),
  defaultOptions: {
    queries: {
      networkMode: "always",
      retry: (count, error) => !isLoggedOut(error) && count < 3,
    },
    mutations: { networkMode: "always" },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);
