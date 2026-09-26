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

/** The engine's clause as a sentence: capitalised, one full stop. */
const sentence = (text: string) =>
  `${text[0]!.toUpperCase()}${text.slice(1).replace(/\.$/, "")}.`;

const statusWords: Record<string, string> = {
  pending: "held up",
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
      // An evaluation error carries what failed, and where, as its evidence.
      const evidence =
        typeof p.evidence === "object" && p.evidence !== null
          ? (p.evidence as Record<string, unknown>)
          : {};
      const error = str(evidence.error) ?? str(p.error);
      const path = str(evidence.path);
      return {
        id,
        title: `${contractName(p.contract, names)}: ${rule} ${
          notice.kind === "violation" ? "tripped" : "could not be evaluated"
        }`,
        text: lines(
          description && `${description.replace(/\.$/, "")}.`,
          block && `Block ${block}.`,
          tx && `Transaction ${tx}.`,
          error &&
            sentence(`${error.replace(/\.$/, "")}${path ? ` at ${path}` : ""}`),
        ),
        link: str(p.rule_id) ? `/violations?rule=${str(p.rule_id)}` : null,
      };
    }
    case "response": {
      const status = str(p.status) ?? "";
      const words = statusWords[status] ?? status;
      const detail = str(p.detail) ?? str(p.error);
      const tail = [
        detail && sentence(detail),
        str(p.tx_hash) && `Transaction ${str(p.tx_hash)}.`,
        str(p.block_number) && `Block ${str(p.block_number)}.`,
      ];
      // A person's pause or unpause from the dashboard.
      if (str(p.action_id)) {
        const verb = str(p.kind)?.startsWith("reset") ? "unpause" : "pause";
        return {
          id,
          title: `${contractName(p.target, names)}: ${verb} by hand ${words}`,
          text: lines(str(p.note) && `“${str(p.note)}”`, ...tail),
          link: "/activity",
        };
      }
      const action = str(p.action) === "call" ? "call" : "pause";
      const response = str(p.response_id);
      const tab =
        status === "awaiting_approval"
          ? "waiting"
          : ["pending", "approved", "submitted"].includes(status)
            ? "in_flight"
            : "history";
      return {
        id,
        title: `${contractName(p.contract, names)}: ${action} ${words}`,
        text: lines(str(p.rule) && `From ${str(p.rule)}.`, ...tail),
        link: response
          ? `/responses?tab=${tab}&open=${response}`
          : "/responses",
      };
    }
    case "health": {
      const status = str(p.status);
      const cause = str(p.cause);
      const back = str(p.previous) === "degraded";
      return {
        id,
        title:
          status === "ready"
            ? back
              ? "Engine caught up"
              : "Engine ready"
            : status === "starting"
              ? "Engine starting"
              : `Engine degraded${cause ? `: ${cause}` : ""}`,
        text:
          status === "ready"
            ? "Tripwire is watching."
            : status === "starting"
              ? "It is catching up with the chain before it evaluates."
              : (cause ?? ""),
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
