# Notifications

How Tripwire tells people what happened: the in-app feed, the alert
channels a person connects, and the alerts about Tripwire itself.
`HIGH-LEVEL-SPEC.md` places the area; `DATABASE.md` holds the tables
named here; `AUTHENTICATION.md` covers who may change channels.

## The split

The engine records; the application delivers.

- **The engine** writes one notification row for every event worth
  telling a person about, in the same transaction as the event
  itself, and exposes the rows two ways: the `api_v1.notifications`
  view and a `notification` event on its stream. Once a row exists it
  is never lost, and no event exists without its row.
- **The application** does everything after the row: the in-app feed
  and read marks, the channels and their secrets, rendering, fan-out,
  retries, storm control, and alerts about the engine's own health,
  which the engine cannot send about itself.

The application is the engine's parent: it starts it, supervises it
and, in local mode, holds its database. So the application is running
whenever the engine is, and it is the one place able to notice the
engine stopping.

## Principles

- **Nothing is dropped.** A notification that should reach a channel
  is retried until it does, however long the channel is down. A
  channel that is down for a weekend delivers its backlog on Monday.
- **Every event is in the feed.** Channels are filtered and storms are
  summarised; the in-app feed always holds each event individually.
- **Readable at 3am.** Every message says what happened, where, how
  bad, and links to the page that shows the evidence.
- **Alerts about Tripwire itself.** An engine that stops, hangs or
  loops is a notification like any other, raised by the application.
- **Secrets stay out of the database.** Channel URLs and tokens are
  secrets and live in a file beside the account files.

## What gets notified

Two sources, one feed. Every notification has a kind and a severity;
channels filter on both.

From the engine:

| Kind | When | Severity |
|-|-|-|
| `violation` | a rule tripped | the rule's severity |
| `evaluation_error` | a rule could not be evaluated (a violation row of that kind) | warning |
| `response` | a response reached `confirmed` | info |
| `response` | a response reached `failed` | critical |
| `response` | a response reached `abandoned` (for example, already paused) | warning |
| `response` | a response is waiting for approval (see requirement N1) | critical |
| `health` | the engine became degraded (lag, RPC failure, missing signer) | warning |
| `health` | the engine is ready again | info |

From the application, kind `system`:

| Event | When | Severity |
|-|-|-|
| engine stopped | the engine process exited without being asked to | critical |
| engine restarting repeatedly | three unplanned restarts within ten minutes; the supervisor backs off | critical |
| engine not responding | the process is alive but its health endpoint has not answered for 60 seconds | critical |
| engine cannot start | the supervisor gave up until something changes: the engine failed verification at install, refused its configuration or schema, or has no build for this platform (`ENGINE.md`, state `failed`) | critical |
| engine recovered | ready again after any of the four above | info |
| database unreachable | the application cannot reach the database for 30 seconds | critical |
| database reachable again | after the above | info |
| channel failing | a channel's oldest undelivered message is an hour old | warning |

A rule's quiet period (`cooldown_seconds`) is applied by the engine: a
trip inside it is recorded as a violation without a new notification.
Evaluation errors have no quiet period, which is why channels exclude
`evaluation_error` by default.

## Channels

A channel is one destination with its own filters.

| Type | Delivery | Settings | Secret |
|-|-|-|-|
| `webhook` | JSON POST of the envelope, signed | none | URL; signing key (generated) |
| `slack` | incoming webhook message | none | webhook URL |
| `discord` | webhook message | none | webhook URL |
| `telegram` | bot API `sendMessage` | chat id | bot token |
| `email` | SMTP, TLS required unless the host is loopback | host, port, from, to, username | password |

Every channel has:

| Field | Values |
|-|-|
| name | unique, up to 60 characters, shown in the dashboard and in failure alerts |
| enabled | on or off; an off channel receives nothing and keeps its backlog for when it is turned back on |
| kinds | any of `violation`, `evaluation_error`, `response`, `health`, `system`; default all but `evaluation_error` |
| minimum severity | `info`, `warning` or `critical`; default `info` |
| storm limit | messages per minute before a digest takes over (see Storms); default 10, `0` turns digests off; webhooks default to `0` |

The in-app feed is not a channel. It needs no setup, has no filter,
and works with no channel configured.

### Where channels live

Channel definitions (name, type, filters, non-secret settings) are rows
in `app.channels`. Secrets are in `TRIPWIRE_HOME/channel-secrets.json`,
mode `0600`, keyed by channel id, written by the same
temporary-file-and-rename rule as the account files. A secret may also
be `env:NAME`, read from the server's environment at send time.

The API accepts secrets and never returns them: a channel reads back
with the names of the secrets it has set. Updating a channel without a
secret keeps the current one.

## Delivery

Three steps, each durable in the `app` schema.

**1. Dispatch.** The dispatcher turns each new notification into one
delivery row per matching channel. It runs when the engine's stream
announces a notification, when the application raises one, and every
five seconds regardless, so a missed stream event costs at most five
seconds. It selects notifications from the last seven days that have
no row in `app.dispatches`, oldest first, up to 200 at a time, and for
each one inserts its delivery rows and its dispatch row in one
transaction. A notification is therefore dispatched exactly once, even
across crashes and even if the engine's ids ever commit out of order.

On an installation's first start, `notifications.dispatch_since` is set
to that moment: notifications recorded before it appear in the feed but
are never sent, so connecting an existing database does not replay old
alerts into Slack. A notification older than seven days that was never
dispatched, because the application was down that long, is likewise
shown and not sent.

**2. Send.** The delivery worker claims due rows (undelivered, next
attempt in the past, channel enabled), oldest first per channel, with
`FOR UPDATE SKIP LOCKED` so two server processes never send the same
row. Each send has a ten-second timeout. Success sets `delivered_at`.
Failure increments `attempts`, records `last_error`, and sets the next
attempt 30 seconds later, doubling to a one-hour cap, with a random
tenth either way so a recovered channel is not hit by the whole
backlog at once. Attempts never stop. Each row is independent, so one
message a channel rejects never blocks the rest.

**3. Settle.** Delivery is at least once: a crash between a send and
its mark repeats that message. Every message carries its notification's
id, so a receiver can drop repeats; webhook receivers should.

### Storms

A rule that trips every block, or an outage that errors every rule,
can produce hundreds of notifications in minutes. Per channel, once a
minute's messages reach the storm limit, the rest of that minute's due
rows are sent as one digest at the end of the minute:

```
[Tripwire] 37 more notifications in the last minute: 31 violations on
Treasury vault, 6 evaluation errors. All of them: https://…/notifications
```

The digested rows are marked delivered with the digest's id. Nothing is
lost: each event is still in the feed, and the digest links there.

### When the database is down

Dispatch and delivery both live in the database, so while it is
unreachable the application keeps a small in-memory queue for its own
`system` notifications: "database unreachable" is sent straight to
every enabled channel using the channel settings it last read,
retried in memory while the process lives, and written to the feed once
the database is back. This is best effort by necessity and the only
path that is.

### When the whole machine is down

Nothing on a dead machine can send an alert. An optional heartbeat
covers this: when `notifications.heartbeat_url` is set, the application
requests it once a minute while the engine reports ready. Pointed at
any dead-man's-switch service, a missing heartbeat alerts from
outside. It is the one alert Tripwire cannot raise itself, and the
dashboard's channel settings recommend setting it up.

## Messages

Each message has a title line, a body, and a link.

| Kind | Title |
|-|-|
| violation | `[CRITICAL] Treasury vault: totalAssets floor tripped` |
| evaluation_error | `[WARNING] Treasury vault: totalAssets floor could not be evaluated` |
| response | `[CRITICAL] Treasury vault: pause failed` |
| health | `[WARNING] Engine degraded: RPC failing` |
| system | `[CRITICAL] Engine stopped` |

The body adds the rule's sentence, the block, the transaction where
there is one, the values that decided it, and, for a failure, the
reason. The link opens the violation, response or status page, built
from `notifications.dashboard_url`; without that setting, messages
carry no link and say so once in the channel settings.

The webhook body is one JSON envelope for every kind:

```json
{
  "id": "engine:18342",
  "source": "engine",
  "kind": "violation",
  "severity": "critical",
  "created_at": "2026-09-26T07:12:44Z",
  "title": "Treasury vault: totalAssets floor tripped",
  "text": "On every block, notify when totalAssets() falls below totalSupply(). Block 21000000.",
  "url": "https://tripwire.example/violations/9121",
  "event": { "…": "the engine's payload, unchanged" }
}
```

Headers: `Tripwire-Timestamp` (unix seconds) and `Tripwire-Signature:
sha256=<hex>`, an HMAC-SHA256 over the timestamp, a full stop and the
raw body, keyed by the channel's signing key. Receivers verify the
signature and refuse timestamps more than five minutes old.

Outbound requests follow three rules: `https` or `http` only, no
redirects followed, and response bodies read up to 64 KB for error
messages and discarded.

## The in-app feed

The Notifications page lists both sources together, newest first, with
filters for kind, severity and unread. Each row shows the title,
severity, time and a link to what it is about. Rows are marked read
individually or all at once; read state is shared by all accounts, as
accounts are equal (`AUTHENTICATION.md`). The shell shows the unread
count, which updates live through the server's event stream to the
browser (`LIVE-UPDATES.md`: the `notification` event carries the new
count, and a `channel` event announces a channel starting or stopping
failing).

The Settings page lists channels with their state: enabled, backlog,
oldest undelivered message, last delivered, last error and, when
failing, since when. Each channel has **Send a test**, which sends a
test message immediately and reports the result, and a delivery log
of its recent attempts.

## Storage

Tables in the `app` schema (`DATABASE.md` defines conventions and
migrations):

| Table | Holds |
|-|-|
| `app.channels` | id, name, type, enabled, kinds, min_severity, storm_limit, settings (jsonb, non-secret), created_at, updated_at |
| `app.local_notifications` | the application's own `system` notifications: id, kind, severity, payload, created_at |
| `app.dispatches` | (source, notification_id) primary key, dispatched_at: which notifications have been fanned out |
| `app.deliveries` | id, source, notification_id, channel_id, attempts, next_attempt_at, delivered_at, digest_id, last_error, created_at; partial index on next_attempt_at where undelivered |
| `app.notification_reads` | (source, notification_id) primary key, read_at |

`source` is `engine` for rows of `api_v1.notifications` and `app` for
rows of `app.local_notifications`; ids are shown as `engine:18342` and
`app:57`.

Retention: delivered delivery rows older than 30 days are deleted,
undelivered ones never; deleting a channel deletes its undelivered rows
after a confirmation that names how many. Local notifications follow
the engine's notification retention (`[retention] notifications_days`,
default 90), and dispatch and read rows are swept once their
notification is gone.

## API

All under `/api/v1`, requiring a session (`AUTHENTICATION.md`), with
the API's error envelope. No MCP tool reads or changes any of it.

| Method | Path | Purpose |
|-|-|-|
| GET | `/notifications` | the feed: `?cursor&kind&severity&unread`; items `{ id, source, kind, severity, title, text, link, createdAt, read }` and `nextCursor` |
| GET | `/notifications/unread-count` | `{ count }` |
| POST | `/notifications/read` | `{ ids }` or `{ all: true }` |
| GET | `/notification-settings` | `{ dashboardUrl, heartbeatUrl }` |
| PUT | `/notification-settings` | same shape |
| GET | `/channels` | channels with state `{ backlog, oldestPendingAt, lastDeliveredAt, lastError, failingSince, secretsSet }` |
| POST | `/channels` | `{ name, type, enabled, kinds, minSeverity, stormLimit, settings, secrets }`; `201`, or `400 invalid_channel`, `409 name_taken` |
| PUT | `/channels/:id` | replace; omitted secrets are kept |
| DELETE | `/channels/:id` | remove it and its undelivered rows |
| POST | `/channels/:id/test` | send a test now; `{ delivered, error }` within the ten-second timeout |
| GET | `/channels/:id/deliveries` | recent attempts, newest first, cursor-paginated |

Creating, changing and deleting a channel is logged at info level
with the username, like the account events in `AUTHENTICATION.md`;
secrets never appear in logs.

## Command line

| Command | Does |
|-|-|
| `tripwire notify list` | channels with their state |
| `tripwire notify test <name>` | sends a test message through one channel |

## What the application requires of the engine

| # | Requirement | Why |
|-|-|-|
| N1 | A `response` notification when a response enters `awaiting_approval`, not only at terminal statuses | in prepare mode the approval is the moment a person must act; a notification only at the end arrives after it no longer helps |
| N2 | The view reference lists each kind's payload fields: for a violation the violation, rule and contract ids and names, severity, block, transaction and the values that decided it; for a response its id, rule, action, status, reason and transaction; for health the new status and cause | messages are rendered from the row alone, and the application's types are generated from that file |
| N3 | `[retention] notifications_days` accepts any value of 7 or more | the dispatcher's seven-day window must stay inside what the engine keeps; the application never writes less |

The application does not depend on notification ids committing in
order: dispatch looks for rows it has not dispatched rather than
resuming after the highest id seen.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| NT1 | Who delivers | The application. It supervises the engine, so it is running whenever the engine is; it is the only party that can alert on the engine's own failure; channel secrets stay out of the engine; and channels change live from the dashboard |
| NT2 | Channel secrets | A `0600` file beside the account files, or `env:` references. The database may be the owner's shared server with its own backups and readers; a Slack webhook URL is a credential |
| NT3 | Dispatch by window rather than by highest id | Looking for undispatched rows in a window is as cheap and does not depend on commit order |
| NT4 | Storm control | Digest per channel per minute, never drop. A flood of identical pages trains people to mute the channel; the feed keeps every event |
| NT5 | Evaluation errors off by default on channels | They repeat every block until fixed. The feed and the rule's status show them; a person opts a channel in |
| NT6 | Old notifications on a new installation | Shown, not sent. Replaying a database's history into a chat channel helps nobody |
| NT7 | Email | Included, through `nodemailer`, the one new dependency: mature, no dependencies of its own, and SMTP by hand is not a hundred lines |
| NT8 | Machine death | A heartbeat to an outside service, optional and recommended. Nothing on the machine can report the machine's death |
| NT9 | Per-account notification preferences | Not in this version. Accounts are equal and channels are shared; per-person routing can follow roles if those arrive |
| NT10 | Browser push notifications | Not in this version. The dashboard shows the unread count live; a push service needs keys and a service worker for little gain over a chat channel |

## Checkpoint

Notifications are done when, provably and repeatably:

1. Every channel type delivers a real message end to end (live
   channels, or protocol-faithful local receivers for webhook and
   SMTP), and a webhook receiver verifies the signature.
2. With a channel unreachable for an hour of a live run, attempts back
   off as specified, nothing is lost, "channel failing" reaches the
   other channels, and the backlog drains completely on recovery.
3. Filters hold: an `info` violation reaches an unfiltered channel and
   not a `warning` one; `evaluation_error` reaches only channels that
   opted in.
4. A storm of 200 violations in a minute reaches a channel with the
   default limit as ten messages and one digest, and all 200 are in the
   feed.
5. `kill -9` of the server during dispatch and during sending: every
   notification is dispatched exactly once, and a repeated message
   carries the same id.
6. Killing the engine produces "engine stopped" and then "engine
   recovered" on every channel; stopping the database produces
   "database unreachable" from memory and the feed shows it once the
   database is back.
7. A fresh installation pointed at a database with old notifications
   sends none of them and shows all of them.
8. No API response and no log line contains a channel secret.
