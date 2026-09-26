// Notifications and alert channels (NOTIFICATIONS.md), shared by the
// server and the dashboard.

import type { Severity } from "./rule";

/** What a notification is about; channels filter on it. */
export const notificationKinds = [
  "violation",
  "evaluation_error",
  "response",
  "health",
  "system",
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

/** A channel's kinds when nobody chose: evaluation errors repeat every block until fixed. */
export const defaultKinds: NotificationKind[] = [
  "violation",
  "response",
  "health",
  "system",
];

/** One entry in the in-app feed. */
export interface NotificationItem {
  /** `engine:18342` or `app:57`. */
  id: string;
  source: "engine" | "app";
  kind: NotificationKind;
  severity: Severity;
  title: string;
  text: string;
  /** The dashboard page that shows what it is about. */
  link: string | null;
  createdAt: string;
  read: boolean;
}

export interface NotificationPage {
  items: NotificationItem[];
  nextCursor: string | null;
}

export interface NotificationSettings {
  /** Where the dashboard is reached from outside; messages link there. */
  dashboardUrl: string | null;
  /** Requested once a minute while the engine is ready, for a dead-man's switch. */
  heartbeatUrl: string | null;
}

export const channelTypes = [
  "webhook",
  "slack",
  "discord",
  "telegram",
  "email",
] as const;
export type ChannelType = (typeof channelTypes)[number];

/** A field a channel type asks for: a setting kept in the database, or a secret kept in a file. */
export interface ChannelField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
}

/** What each type needs. A webhook's signing key is generated, never entered. */
export const channelFields: Record<ChannelType, ChannelField[]> = {
  webhook: [
    {
      key: "url",
      label: "URL",
      secret: true,
      required: true,
      placeholder: "https://…",
    },
  ],
  slack: [
    {
      key: "url",
      label: "Webhook URL",
      secret: true,
      required: true,
      placeholder: "https://hooks.slack.com/services/…",
    },
  ],
  discord: [
    {
      key: "url",
      label: "Webhook URL",
      secret: true,
      required: true,
      placeholder: "https://discord.com/api/webhooks/…",
    },
  ],
  telegram: [
    {
      key: "chatId",
      label: "Chat id",
      secret: false,
      required: true,
      placeholder: "-1001234567890",
    },
    { key: "botToken", label: "Bot token", secret: true, required: true },
  ],
  email: [
    {
      key: "host",
      label: "SMTP host",
      secret: false,
      required: true,
      placeholder: "smtp.example.com",
    },
    {
      key: "port",
      label: "Port",
      secret: false,
      required: true,
      placeholder: "587",
    },
    { key: "from", label: "From", secret: false, required: true },
    { key: "to", label: "To", secret: false, required: true },
    { key: "username", label: "Username", secret: false, required: false },
    { key: "password", label: "Password", secret: true, required: false },
  ],
};

/** A channel as the API shows it: never its secrets, only which are set. */
export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  kinds: NotificationKind[];
  minSeverity: Severity;
  /** Messages a minute before a digest takes over; 0 turns digests off. */
  stormLimit: number;
  settings: Record<string, string>;
  secretsSet: string[];
  state: {
    backlog: number;
    oldestPendingAt: string | null;
    lastDeliveredAt: string | null;
    lastError: string | null;
    /** Since when its oldest undelivered message has been failing. */
    failingSince: string | null;
  };
}

/** Creating or replacing a channel; omitted secrets are kept. */
export interface ChannelInput {
  name: string;
  type: ChannelType;
  enabled: boolean;
  kinds: NotificationKind[];
  minSeverity: Severity;
  stormLimit: number;
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

export interface ChannelTest {
  delivered: boolean;
  error: string | null;
}

/** One notification's delivery to one channel. */
export interface ChannelDelivery {
  id: string;
  notificationId: string;
  title: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  digestId: string | null;
  lastError: string | null;
  createdAt: string;
}
