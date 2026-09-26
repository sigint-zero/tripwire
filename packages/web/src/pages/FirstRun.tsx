import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard } from "../components/AuthCard";
import { Button, fieldClass, labelClass } from "../components/ui";
import { auth } from "../lib/api";

/** First run starts with the account that protects everything else. */
export function FirstRunPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const create = useMutation({
    mutationFn: () => auth.createFirstAccount(username, password),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: "/" });
    },
  });
  const mismatch = again !== "" && again !== password;

  return (
    <AuthCard
      title="Set up Tripwire"
      hint="Create the account that protects this installation."
      onSubmit={() => !mismatch && create.mutate()}
    >
      <label className="block">
        <span className={labelClass}>Username</span>
        <input
          className={fieldClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          pattern="[A-Za-z0-9._\-]{1,64}"
          title="Letters, digits, dots, dashes and underscores"
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
          autoComplete="new-password"
          minLength={12}
          placeholder="12 characters or more"
          required
        />
      </label>
      <label className="block">
        <span className={labelClass}>Confirm password</span>
        <input
          className={fieldClass}
          type="password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          autoComplete="new-password"
          required
        />
        {mismatch && (
          <span className="mt-2 block text-xs text-amber-400">
            The passwords do not match.
          </span>
        )}
      </label>
      {create.error && (
        <p className="text-sm text-red-400">{create.error.message}</p>
      )}
      <Button
        type="submit"
        className="w-full"
        disabled={mismatch || create.isPending}
      >
        {create.isPending ? "Creating…" : "Create account"}
      </Button>
    </AuthCard>
  );
}
