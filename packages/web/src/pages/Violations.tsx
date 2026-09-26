import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { Button, choice, EmptyState, track } from "../components/ui";
import { ViolationList } from "../components/ViolationList";
import { api } from "../lib/api";

const PAGE = 200;

const views = [
  { open: true, title: "Open", hint: "Not acknowledged yet" },
  { open: false, title: "All", hint: "Including acknowledged" },
];

export function ViolationsPage() {
  const [open, setOpen] = useState(true);
  const violations = useInfiniteQuery({
    queryKey: ["violations", { open }],
    queryFn: ({ pageParam, signal }) =>
      api.violations({ open, before: pageParam, limit: PAGE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) =>
      last.length === PAGE ? last.at(-1)?.id : undefined,
    // Until events stream in, a new block's worth every 12 seconds.
    refetchInterval: 12_000,
  });
  const { data: contracts } = useQuery({
    queryKey: ["contracts"],
    queryFn: ({ signal }) => api.contracts(signal),
  });
  const { data: rules } = useQuery({
    queryKey: ["rules"],
    queryFn: ({ signal }) => api.rules(undefined, signal),
  });
  const list = violations.data?.pages.flat();

  return (
    <div>
      <PageHeader
        title="Violations"
        description="Every time a rule tripped, with what the engine saw."
      />

      <div className={`mb-6 ${track}`}>
        {views.map((view) => (
          <button
            key={view.title}
            type="button"
            title={view.hint}
            onClick={() => setOpen(view.open)}
            className={choice(open === view.open)}
          >
            {view.title}
          </button>
        ))}
      </div>

      {violations.error && (
        <p className="text-sm text-red-400">{violations.error.message}</p>
      )}

      {list?.length === 0 && (
        <EmptyState
          title={open ? "Nothing open" : "No violations yet"}
          hint={
            open
              ? "Every violation has been acknowledged."
              : "When a rule trips, it shows up here."
          }
        />
      )}

      {list && list.length > 0 && (
        <>
          <ViolationList
            violations={list}
            contracts={contracts ?? []}
            rules={rules}
          />
          {violations.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="ghost"
                disabled={violations.isFetchingNextPage}
                onClick={() => void violations.fetchNextPage()}
              >
                Older
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
