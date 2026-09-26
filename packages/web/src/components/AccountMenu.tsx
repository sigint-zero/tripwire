import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { auth } from "../lib/api";

/** Ends this session and goes to the login page. */
export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: auth.logout,
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: "/login" });
    },
  });
}

const item =
  "block w-full px-4 py-2.5 text-left text-xs font-bold tracking-[0.2em] uppercase text-gray-400 transition-colors hover:bg-emerald-500/5 hover:text-emerald-400 disabled:opacity-50";

/** Who is logged in, with the way to their account and out. */
export function AccountMenu() {
  const { data: session } = useQuery({
    queryKey: ["auth", "session"],
    queryFn: ({ signal }) => auth.session(signal),
  });
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!session) return null;
  const { username } = session.user;
  const until = new Date(session.expiresAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div ref={menu} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex cursor-pointer items-center gap-2.5 py-1.5 pr-3 pl-1.5 transition-colors ${
          open ? "bg-white/6" : "bg-white/3 hover:bg-white/6"
        }`}
      >
        <span className="flex size-6 items-center justify-center bg-emerald-500/15 font-mono text-xs font-bold text-emerald-400 uppercase">
          {username[0]}
        </span>
        <span className="font-mono text-sm text-gray-200">{username}</span>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          className={`size-3.5 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m5 8 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 bg-panel shadow-lg shadow-black/40"
        >
          <p
            className="bg-white/3 px-4 py-3 text-xs text-gray-500"
            title="Sessions last a day from login"
          >
            Logged in until <span className="font-mono">{until}</span>
          </p>
          <Link
            to="/settings"
            role="menuitem"
            className={item}
            onClick={() => setOpen(false)}
          >
            Account settings
          </Link>
          <button
            type="button"
            role="menuitem"
            className={`${item} cursor-pointer hover:bg-red-500/5! hover:text-red-400!`}
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
