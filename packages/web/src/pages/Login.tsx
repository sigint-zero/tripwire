import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard } from "../components/AuthCard";
import { Button, fieldClass, labelClass } from "../components/ui";
import { auth } from "../lib/api";

/** Username and password, then back to where the person was going. */
export function LoginPage({ redirect }: { redirect?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => auth.login(username, password),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ href: redirect ?? "/" });
    },
  });

  return (
    <AuthCard title="Log in" onSubmit={() => login.mutate()}>
      <label className="block">
        <span className={labelClass}>Username</span>
        <input
          className={fieldClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
      </label>
      <label className="block">
        <span className={labelClass}>Password</span>
        <input
          className={fieldClass}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      {login.error && (
        <p className="text-sm text-red-400">{login.error.message}</p>
      )}
      <Button type="submit" className="w-full" disabled={login.isPending}>
        {login.isPending ? "Logging in…" : "Log in"}
      </Button>
      <p
        className="text-xs text-gray-600"
        title="Run tripwire user passwd <name> on the machine Tripwire runs on."
      >
        Forgot the password?
      </p>
    </AuthCard>
  );
}
