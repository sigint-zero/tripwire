import type {
  NotificationItem,
  NotificationKind,
  Severity,
} from "@tripwire/shared";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { PageHeader } from "../components/PageHeader";
import { Button, choice, EmptyState, track } from "../components/ui";
import { SeverityIcon } from "../components/wizard/ResponseStep";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";

/** What the feed shows, kept in the URL so a view can be linked. */
export interface NotificationsSearch {
  kind?: NotificationKind;
  severity?: Severity;
  unread?: boolean;
}

const KINDS: { kind?: NotificationKind; title: string; hint: string }[] = [
  { title: "Everything", hint: "Every kind of notification" },
  { kind: "violation", title: "Violations", hint: "Rules that tripped" },
  {
    kind: "evaluation_error",
    title: "Errors",
    hint: "Rules that could not be evaluated",
  },
  { kind: "response", title: "Responses", hint: "On-chain responses" },
  {
    kind: "health",
    title: "Engine",
    hint: "The engine falling behind or recovering",
  },
  {
    kind: "system",
    title: "Tripwire",
    hint: "Tripwire itself: its engine and channels",
  },
];
const SEVERITIES: Severity[] = ["critical", "warning", "info"];

export function readNotificationsSearch(
  search: Record<string, unknown>,
): NotificationsSearch {
  const read: NotificationsSearch = {};
  if (KINDS.some((k) => k.kind && k.kind === search.kind)) {
    read.kind = search.kind as NotificationKind;
  }
  if (SEVERITIES.includes(search.severity as Severity)) {
    read.severity = search.severity as Severity;
  }
  if (search.unread === true) read.unread = true;
  return read;
}

const select =
  "cursor-pointer bg-white/3 px-3 py-2.5 text-xs text-gray-300 transition-colors hover:bg-white/5 focus:bg-white/5 focus:outline-none";

export function NotificationsPage({
  search,
  onSearch,
}: {
  search: NotificationsSearch;
  onSearch: (next: NotificationsSearch) => void;
}) {
  const queryClient = useQueryClient();
  const { kind, severity, unread } = search;
  const feed = useInfiniteQuery({
    queryKey: ["notifications", "feed", { kind, severity, unread }],
    queryFn: ({ pageParam, signal }) =>
      api.notifications({ cursor: pageParam, kind, severity, unread }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const { data: unreadCount } = useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: ({ signal }) => api.unreadCount(signal),
  });
  const markRead = useMutation({
    mutationFn: api.markRead,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const items = feed.data?.pages.flatMap((p) => p.items);
  const set = (change: Partial<NotificationsSearch>) =>
    onSearch({ ...search, ...change });
  const narrowed = kind !== undefined || severity !== undefined || unread;

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Everything Tripwire had to say, newest first. Alert channels are set up in Settings."
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className={track}>
          {[
            { unread: false, title: "All" },
            { unread: true, title: "Unread" },
          ].map((view) => (
            <button
              key={view.title}
              type="button"
              onClick={() => set({ unread: view.unread || undefined })}
              className={choice(!!unread === view.unread)}
            >
              {view.title}
            </button>
          ))}
        </div>
        <select
          aria-label="Kind"
          value={kind ?? ""}
          onChange={(e) =>
            set({ kind: (e.target.value || undefined) as NotificationKind })
          }
          className={select}
        >
          {KINDS.map((k) => (
            <option key={k.title} value={k.kind ?? ""} title={k.hint}>
              {k.title}
            </option>
          ))}
        </select>
        <select
          aria-label="Severity"
          value={severity ?? ""}
          onChange={(e) =>
            set({ severity: (e.target.value || undefined) as Severity })
          }
          className={select}
        >
          <option value="">Any severity</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        {narrowed && (
          <button
            type="button"
            onClick={() => onSearch({})}
            className="cursor-pointer text-[10px] font-bold tracking-[0.2em] text-gray-500 uppercase transition-colors hover:text-gray-300"
          >
            Clear
          </button>
        )}
        {(unreadCount?.count ?? 0) > 0 && (
          <Button
            variant="quiet"
            className="ml-auto"
            disabled={markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
          >
            Mark all read
          </Button>
        )}
      </div>

      {feed.error && (
        <p className="text-sm text-red-400">{feed.error.message}</p>
      )}

      {items?.length === 0 && (
        <EmptyState
          title={narrowed ? "Nothing matches" : "Nothing yet"}
          hint={
            narrowed
              ? "No notification fits these filters."
              : "When a rule trips or Tripwire needs you, it shows up here."
          }
        />
      )}

      {items && items.length > 0 && (
        <>
          <ul className="space-y-1">
            {items.map((item) => (
              <Row
                key={item.id}
                item={item}
                onRead={() => {
                  if (!item.read) markRead.mutate({ ids: [item.id] });
                }}
              />
            ))}
          </ul>
          {feed.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="ghost"
                disabled={feed.isFetchingNextPage}
                onClick={() => void feed.fetchNextPage()}
              >
                {feed.isFetchingNextPage ? "Loading…" : "Older"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({ item, onRead }: { item: NotificationItem; onRead: () => void }) {
  const navigate = useNavigate();
  const open = () => {
    onRead();
    // The link carries its own query: the router is given the whole address.
    if (item.link) void navigate({ href: item.link });
  };
  return (
    <li>
      <button
        type="button"
        onClick={open}
        className={`flex w-full cursor-pointer items-start gap-4 px-5 py-3.5 text-left transition-colors ${item.read ? "bg-white/2 hover:bg-white/4" : "bg-white/4 hover:bg-white/6"}`}
      >
        <span className="mt-0.5 flex items-center gap-2">
          <span
            aria-label={item.read ? undefined : "Unread"}
            className={`size-1.5 ${item.read ? "bg-transparent" : "bg-emerald-400"}`}
          />
          <SeverityIcon severity={item.severity} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block text-sm ${item.read ? "text-gray-400" : "text-white"}`}
          >
            {item.title}
          </span>
          {item.text && (
            <span className="mt-0.5 line-clamp-2 block text-xs wrap-anywhere text-gray-500">
              {item.text}
            </span>
          )}
        </span>
        <span
          className="shrink-0 font-mono text-xs text-gray-500"
          title={new Date(item.createdAt).toLocaleString()}
        >
          {timeAgo(item.createdAt)}
        </span>
      </button>
    </li>
  );
}
