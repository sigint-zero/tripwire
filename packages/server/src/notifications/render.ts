import type { NotificationItem } from "@tripwire/shared";
import type { NoticeRow } from "./store";

// Every message says what happened, where, how bad, and links to the page
// that shows the evidence (NOTIFICATIONS.md, Messages). A notification is
// rendered from its row alone, with the registered contracts' names.

export interface Rendered {
  /** `engine:18342`. */
  id: string;
  /** Without the severity, which is shown beside it. */
  title: string;
  text: string;
  /** The dashboard path that shows it. */
  link: string | null;
}

const str = (v: unknown) =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;

const statusWords: Record<string, string> = {
  awaiting_approval: "waiting for approval",
  confirmed: "confirmed",
  failed: "failed",
  abandoned: "abandoned",
};

function contractName(address: unknown, names: Map<string, string>): string {
  const at = str(address)?.toLowerCase();
  if (!at) return "A contract";
  return names.get(at) ?? `${at.slice(0, 6)}…${at.slice(-4)}`;
}

export function render(
  notice: NoticeRow,
  names: Map<string, string>,
): Rendered {
  const p = notice.payload;
  const id = `${notice.source}:${notice.id}`;
  const lines = (...parts: (string | null | false)[]) =>
    parts.filter(Boolean).join(" ");
  switch (notice.kind) {
    case "violation":
    case "evaluation_error": {
      const rule = str(p.rule) ?? "A rule";
      const block = str(p.block_number);
      const tx = str(p.tx_hash);
      const description = str(p.description);
      return {
        id,
        title: `${contractName(p.contract, names)}: ${rule} ${
          notice.kind === "violation" ? "tripped" : "could not be evaluated"
        }`,
        text: lines(
          description && `${description.replace(/\.$/, "")}.`,
          block && `Block ${block}.`,
          tx && `Transaction ${tx}.`,
          str(p.error) && `${str(p.error)}.`,
        ),
        link: str(p.rule_id) ? `/violations?rule=${str(p.rule_id)}` : null,
      };
    }
    case "response": {
      const status = str(p.status) ?? "";
      const action = str(p.action) === "call" ? "call" : "pause";
      const response = str(p.response_id);
      return {
        id,
        title: `${contractName(p.contract, names)}: ${action} ${statusWords[status] ?? status}`,
        text: lines(
          str(p.rule) && `From ${str(p.rule)}.`,
          str(p.reason) && `${str(p.reason)!.replace(/\.$/, "")}.`,
          str(p.tx_hash) && `Transaction ${str(p.tx_hash)}.`,
        ),
        link: response
          ? `/responses?tab=${status === "awaiting_approval" ? "waiting" : "history"}&open=${response}`
          : "/responses",
      };
    }
    case "health": {
      const ready = str(p.status) === "ready";
      const cause = str(p.cause);
      return {
        id,
        title: ready
          ? "Engine ready"
          : `Engine degraded${cause ? `: ${cause}` : ""}`,
        text: ready ? "Tripwire is watching again." : (cause ?? ""),
        link: "/",
      };
    }
    case "system":
      return {
        id,
        title: str(p.title) ?? "Tripwire",
        text: str(p.text) ?? "",
        link: str(p.link) ?? "/",
      };
  }
}

export function toItem(
  notice: NoticeRow,
  names: Map<string, string>,
): NotificationItem {
  const rendered = render(notice, names);
  return {
    id: rendered.id,
    source: notice.source,
    kind: notice.kind,
    severity: notice.severity,
    title: rendered.title,
    text: rendered.text,
    link: rendered.link,
    createdAt: notice.created_at.toISOString(),
    read: notice.read,
  };
}

/** A path on the dashboard as a full address, when the dashboard's address is known. */
export function absolute(
  dashboardUrl: string | null,
  link: string | null,
): string | null {
  if (!dashboardUrl || !link) return null;
  return `${dashboardUrl.replace(/\/+$/, "")}${link}`;
}
