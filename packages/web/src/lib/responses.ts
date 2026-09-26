import type { ResponseStatus } from "@tripwire/shared";

/** A response's status in words, and the colour that says how it went. */
export const responseStatuses: Record<
  ResponseStatus,
  { label: string; tone: string }
> = {
  pending: { label: "Being prepared", tone: "text-gray-400" },
  awaiting_approval: { label: "Waiting for approval", tone: "text-amber-400" },
  approved: { label: "Approved", tone: "text-gray-300" },
  submitted: { label: "Sent", tone: "text-gray-300" },
  confirmed: { label: "Confirmed", tone: "text-emerald-400" },
  failed: { label: "Failed", tone: "text-red-400" },
  abandoned: { label: "Abandoned", tone: "text-gray-500" },
};
