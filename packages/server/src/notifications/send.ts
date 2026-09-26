import type { ChannelType, Severity } from "@tripwire/shared";
import { createHmac } from "node:crypto";
import { createTransport } from "nodemailer";

// One message to one channel. Outbound requests take `http` or `https`
// only, follow no redirects, time out after ten seconds, and read at most
// 64 KB of a reply, only to report an error.

export interface Message {
  /** The notification's id, so a receiver can drop repeats: `engine:18342`. */
  id: string;
  source: "engine" | "app";
  kind: string;
  severity: Severity;
  createdAt: string;
  title: string;
  text: string;
  url: string | null;
  /** The engine's payload, unchanged, for webhooks. */
  event: unknown;
}

export interface Target {
  type: ChannelType;
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

const TIMEOUT_MS = 10_000;
const MAX_REPLY = 64 * 1024;

/** `[CRITICAL] Treasury vault: totalAssets floor tripped`. */
export function subject(message: Message): string {
  return `[${message.severity.toUpperCase()}] ${message.title}`;
}

function plain(message: Message): string {
  return [subject(message), message.text, message.url]
    .filter(Boolean)
    .join("\n");
}

/** Sends, or throws with why not. */
export async function send(target: Target, message: Message): Promise<void> {
  const { settings, secrets } = target;
  switch (target.type) {
    case "webhook": {
      const body = JSON.stringify({
        id: message.id,
        source: message.source,
        kind: message.kind,
        severity: message.severity,
        created_at: message.createdAt,
        title: message.title,
        text: message.text,
        url: message.url,
        event: message.event,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", need(secrets, "signingKey"))
        .update(`${timestamp}.${body}`)
        .digest("hex");
      return post(need(secrets, "url"), body, {
        "Tripwire-Timestamp": timestamp,
        "Tripwire-Signature": `sha256=${signature}`,
      });
    }
    case "slack":
      return post(
        need(secrets, "url"),
        JSON.stringify({
          text: [
            `*${subject(message)}*`,
            message.text,
            message.url && `<${message.url}|Open in Tripwire>`,
          ]
            .filter(Boolean)
            .join("\n"),
        }),
      );
    case "discord":
      return post(
        need(secrets, "url"),
        JSON.stringify({
          content: [
            `**${subject(message)}**`,
            message.text,
            message.url && `<${message.url}>`,
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 2000),
          allowed_mentions: { parse: [] },
        }),
      );
    case "telegram":
      return post(
        `https://api.telegram.org/bot${need(secrets, "botToken")}/sendMessage`,
        JSON.stringify({
          chat_id: need(settings, "chatId"),
          text: plain(message).slice(0, 4096),
          disable_web_page_preview: true,
        }),
        {},
        // The bot token is in the path: it never reaches an error message.
        "the Telegram API",
      );
    case "email": {
      const host = need(settings, "host");
      const port = Number(need(settings, "port"));
      const loopback = /^(localhost|127\.|::1$)/.test(host);
      const transport = createTransport({
        host,
        port,
        secure: port === 465,
        // TLS is required unless the server is on this machine.
        requireTLS: !loopback && port !== 465,
        ignoreTLS: loopback,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
        ...(settings.username
          ? { auth: { user: settings.username, pass: secrets.password ?? "" } }
          : {}),
      });
      try {
        await transport.sendMail({
          from: need(settings, "from"),
          to: need(settings, "to"),
          subject: subject(message),
          text: [message.text, message.url].filter(Boolean).join("\n\n"),
        });
      } finally {
        transport.close();
      }
      return;
    }
  }
}

function need(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`The channel has no ${key} set.`);
  return value;
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
  /** How the destination is named in errors, when its address is a secret. */
  named?: string,
): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("Only http and https addresses are allowed.");
  }
  const where = named ?? target.host;
  let response: Response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ${where}: ${cause}`, { cause: error });
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error(
      `${where} answered with a redirect, which is not followed.`,
    );
  }
  if (!response.ok) {
    const reply = await readCapped(response);
    throw new Error(
      `${where} answered ${response.status}${reply ? `: ${reply.slice(0, 200)}` : "."}`,
    );
  }
  await response.body?.cancel();
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader() as
    ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_REPLY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8", 0, MAX_REPLY).trim();
}
