import { createServer, type Server } from "node:http";
import { createServer as createTcp, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { send, type Message } from "./send";

// Each channel type's wire format, against local receivers that speak the
// protocol: HTTP for the chat webhooks, SMTP for email.

const message: Message = {
  id: "engine:7",
  source: "engine",
  kind: "violation",
  severity: "critical",
  createdAt: "2026-09-26T07:12:44.000Z",
  title: "Treasury vault: totalAssets floor tripped",
  text: "On every block, notify when totalAssets() falls below totalSupply(). Block 21000000.",
  url: "https://tripwire.example/violations?rule=3",
  event: {},
};

let http: Server;
let base: string;
let bodies: { path: string; body: string }[] = [];
let smtp: TcpServer;
let smtpPort: number;
let mail: string[] = [];

beforeAll(async () => {
  http = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      bodies.push({ path: request.url!, body });
      if (request.url === "/moved") {
        response.writeHead(302, { location: "http://example.com" }).end();
      } else {
        response.writeHead(200).end("ok");
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  // Just enough SMTP to take one message.
  smtp = createTcp((socket) => {
    let data = false;
    let buffer = "";
    socket.write("220 localhost ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false;
            socket.write("250 queued\r\n");
          } else mail.push(line);
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO")
          socket.write("250 localhost\r\n");
        else if (verb === "DATA") {
          data = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  smtpPort = (smtp.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((resolve) => http.close(resolve));
  await new Promise((resolve) => smtp.close(resolve));
});

describe("channel types", () => {
  it("posts Slack's text with the severity, the evidence and a link", async () => {
    bodies = [];
    await send(
      { type: "slack", settings: {}, secrets: { url: `${base}/slack` } },
      message,
    );
    expect(JSON.parse(bodies[0]!.body)).toEqual({
      text: [
        "*[CRITICAL] Treasury vault: totalAssets floor tripped*",
        message.text,
        `<${message.url}|Open in Tripwire>`,
      ].join("\n"),
    });
  });

  it("posts Discord's content with no mentions", async () => {
    bodies = [];
    await send(
      { type: "discord", settings: {}, secrets: { url: `${base}/discord` } },
      message,
    );
    expect(JSON.parse(bodies[0]!.body)).toMatchObject({
      content: expect.stringMatching(
        /^\*\*\[CRITICAL\] Treasury vault/,
      ) as unknown,
      allowed_mentions: { parse: [] },
    });
  });

  it("does not follow a redirect", async () => {
    await expect(
      send(
        { type: "slack", settings: {}, secrets: { url: `${base}/moved` } },
        message,
      ),
    ).rejects.toThrow(/redirect, which is not followed/);
  });

  it("mails through SMTP on this machine, subject first", async () => {
    mail = [];
    await send(
      {
        type: "email",
        settings: {
          host: "127.0.0.1",
          port: String(smtpPort),
          from: "tripwire@example.com",
          to: "oncall@example.com",
        },
        secrets: {},
      },
      message,
    );
    const text = mail.join("\n");
    expect(text).toMatch(
      /Subject: \[CRITICAL\] Treasury vault: totalAssets floor tripped/,
    );
    // The body is quoted-printable: soft line breaks, and "=" as "=3D".
    const body = text.replace(/=\n/g, "").replace(/=3D/g, "=");
    expect(body).toContain("https://tripwire.example/violations?rule=3");
  });
});
