# Live updates

How the dashboard learns that something changed without asking every
few seconds: the server's one connection to the engine's event stream,
the stream the server offers the browser, and how the dashboard turns
an event into fresh data. `HIGH-LEVEL-SPEC.md` places it;
`NOTIFICATIONS.md` and `ENGINE.md` are the other consumers of the
engine's stream inside the server; `AUTHENTICATION.md` covers who may
open the browser stream.

## Principles

- **The API is the only data path.** An event says what changed; the
  dashboard then reads it through `/api/v1` as it always does. Nothing
  is rendered from an event's payload alone, so a page never shows a
  shape the API would not have returned.
- **No event is trusted to arrive.** The engine's stream has no replay,
  and neither has the server's. Every gap ends in a resync: refetch
  what is on screen. A missed event costs a refetch, never a wrong
  page.
- **One upstream connection.** However many tabs are open, the engine
  sees one client: the server.

## The engine's stream

The engine publishes server-sent events at `GET /v1/events` on its
control interface, authenticated with the interface secret as
`Authorization: Bearer <secret>`, like every other request to it.

| Event | Fired |
|-|-|
| `block` | each committed block: number, hash, time |
| `violation` | each recorded violation, tripped, evaluation error and pending alike |
| `rule_state` | a rule's `warming` or `enabled` flips |
| `trip_state` | the pause state changes, from the controller or from a call's confirmation |
| `response` | a response changes status |
| `notification` | a notification row is recorded |
| `health` | the engine's health status changes |

What the application relies on:

- Payloads mirror the corresponding view rows, so the server reads an
  event with the same types it reads the views with.
- Ids are monotonic within one connection. There is no replay and no
  `Last-Event-ID`: history is the views' job.
- The engine never drops an event silently. A client too slow to keep
  up is disconnected and told why; from the application's side that is
  one more reconnect.

## The server's upstream connection

The server opens one connection to the engine's stream when the engine
first reports `starting` or `ready` (`ENGINE.md`), and keeps it for as
long as the engine runs.

| Situation | Server behaviour |
|-|-|
| connection opens | sends `resync` to every browser stream, since anything may have changed while it was down |
| connection drops, engine still running | reconnects after 1 second, doubling to a 30-second cap, with a random tenth either way; resets after a minute connected |
| engine stops or restarts | closes the connection; the supervisor's own state reaches the browser as `health`; reconnects once the engine is `starting` again |
| an event fails to parse | logged at warn with its name and id, then treated as `resync`: the server does not guess |
| `401` from the engine | the secret changed under it (a new data directory): the server re-reads the secret file once and reconnects; a second `401` is logged at error, and the connection stays closed until the engine next starts, with the browser streams told `resync` and the 60-second poll taking over |

Consumers inside the server, all fed from this one connection:

| Consumer | Uses |
|-|-|
| the notification dispatcher (`NOTIFICATIONS.md`) | `notification`, to dispatch at once instead of at its next five-second pass; it never depends on the event, since it also runs on its timer |
| the supervisor (`ENGINE.md`) | `health`, to move between `ready` and `degraded` without waiting for its next poll |
| the browser relay (below) | every event |

## The browser stream

`GET /api/v1/events`, server-sent events, `text/event-stream`.

- **Who.** A session cookie, like every other route
  (`AUTHENTICATION.md`). MCP tokens are refused with `401`: agents get
  no live feed.
- **Session end.** The server closes the stream when the session
  expires or is revoked. The browser's reconnect then gets `401`, and
  the dashboard handles it as any other `401`: clear the query cache,
  go to `/login`.
- **Per session.** At most ten open streams per session, one per tab
  in practice. The eleventh closes the oldest, which reconnects if its
  tab is still open, so a leaked stream never pins a slot.
- **Keep-alive.** A comment line every 15 seconds, so proxies and
  load balancers do not close an idle connection. Responses carry
  `Cache-Control: no-cache` and `X-Accel-Buffering: no`, so a reverse
  proxy (`--behind-proxy`) passes events on as they are written.
- **Ids.** The server numbers its own events per connection. It
  ignores `Last-Event-ID`; a reconnecting browser starts with `resync`.

### Events to the browser

Payloads are small: which thing changed, and just enough to decide
what to refetch or whether to show a toast. Full rows come from the
API.

| Event | Payload | From |
|-|-|-|
| `block` | `{ number, time }` | engine `block`, throttled: at most one per second, the latest wins |
| `violation` | `{ id, ruleId, contractAddress, kind, severity }` | engine `violation` |
| `rule_state` | `{ ruleId, enabled, warming }` | engine `rule_state` |
| `trip_state` | `{ contractAddress, selector, source, tripped }` | engine `trip_state` |
| `response` | `{ id, ruleId, status }` | engine `response` |
| `notification` | `{ id, source, kind, severity, unread }` | engine `notification`, and the application's own `system` notifications; `unread` is the new unread count |
| `health` | `{ state, since }` | the supervisor: the engine states in `ENGINE.md`, including those the engine cannot report about itself (`unresponsive`, `restarting`, `failed`, `stopped`) |
| `settings` | `{ area, applied }` | the application, when a settings change was applied or rolled back (`SETTINGS.md`) |
| `channel` | `{ id, failing }` | the application, when an alert channel starts or stops failing (`NOTIFICATIONS.md`) |
| `resync` | `{ reason }` | the server: the upstream reconnected, or this browser fell behind |

`block` is throttled because a fast chain produces several blocks a
second and nothing on screen needs more than one head update a
second. Every other event is passed on as it arrives.

### Backpressure

Each browser connection has a queue of 256 events. When a browser
cannot keep up and its queue is full, the server writes one final
`resync` with reason `behind` and closes the connection. The browser
reconnects, receives `resync` again, and refetches. No event is
dropped from a connection that stays open.

## The dashboard

One `EventSource` per tab, opened after login by the shell and closed
at logout.

### Invalidate, not patch

On each event the dashboard invalidates the queries that could have
changed; TanStack Query refetches those that are on screen and marks
the rest stale. It never writes an event's payload into the cache.

| Event | Invalidates |
|-|-|
| `violation` | `["violations", ...]` (every filter), `["rules"]`, `["rule", ruleId]`, `["contracts"]`, `["trip-state"]` |
| `rule_state` | `["rules"]`, `["rule", ruleId]`, `["contracts"]`, `["contract", address]` |
| `trip_state` | `["trip-state"]`, `["contracts"]`, `["contract", contractAddress]`, `["activity", ...]` |
| `response` | `["responses", ...]`, `["response", id]`, `["violations", ...]` |
| `notification` | `["notifications", ...]`; the unread count is set from the payload, the one value taken straight from an event, because it is a number the shell shows and nothing else |
| `health` | `["engine"]` |
| `settings` | `["engine"]`, `["settings", area]` |
| `channel` | `["channels"]` |
| `block` | nothing; updates the head shown in the health strip (`OVERVIEW.md`) |
| `resync` | every query |

Invalidating `["violations", ...]` means the prefix: every
`["violations", { ... }]` key whatever its filter. `["trip-state"]`,
`["responses", ...]`, `["response", id]`, `["notifications", ...]`,
`["activity", ...]`, `["channels"]` and `["settings", area]` are the
keys of the pages specified in `ACTIVITY.md`, `RESPONSES.md`,
`NOTIFICATIONS.md` and `SETTINGS.md`.

Chart queries are not invalidated per block. A chart whose range ends
at "now" refetches on its own interval (`RULES.md`), so a fast chain
does not cause a request per block per chart.

### Polling

The 12-second `refetchInterval` on the Overview, Violations and rule
pages is removed; the stream replaces it. While the stream is
disconnected, the shell turns on a 60-second poll of every query on
screen, and turns it off at the next `resync`.

The shell's server indicator keeps polling `/api/v1/health`, which
needs no session, every ten seconds, so "server unreachable" stays
distinct from "logged out" (`AUTHENTICATION.md`). Beside it, the shell
shows the stream's state:

| Stream | Shown |
|-|-|
| open | nothing extra |
| reconnecting | "Reconnecting, updates paused" after five seconds without a connection |
| closed by `401` | nothing: the dashboard is already on its way to `/login` |

`EventSource` reconnects on its own; the dashboard adds only the
`401` check (a failed reconnect is followed by one `GET /auth/session`
to tell expiry from a network drop) and the indicator.

## The stand-in

The development stand-in (`ENGINE.md`) emits the same events through
the same relay: a simulated block each tick, and `violation`,
`rule_state` and so on as its simulated evaluation produces them. The
browser cannot tell it from the engine, apart from the Stand-in
label in the shell's chain badge and the Overview's health strip
(`OVERVIEW.md`).

## API

| Method | Path | Purpose |
|-|-|-|
| GET | `/events` | the browser stream: server-sent events as above; `401` without a session or with an MCP token |

No MCP tool reads the stream.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| LU1 | Invalidate or patch the cache | Invalidate. One data path means one shape and one set of permissions; patching would need every page's shapes rebuilt from event payloads, and a missed event would leave a wrong page instead of a stale one |
| LU2 | One upstream connection | Yes. The engine's stream is sized for one consumer, and the server needs the events itself for dispatch and supervision anyway |
| LU3 | Replay | None, as the engine offers none. `resync` on every reconnect is simpler than remembering ids, and correct for the same reason the engine's own design is: history lives in the views |
| LU4 | Server-sent events or WebSocket | Server-sent events. One direction is all that is needed, it reconnects on its own, it passes through proxies as a plain response, and the session cookie authenticates it with no extra step |
| LU5 | Block events | Throttled to one a second. A head number is the only thing a block changes on screen |
| LU6 | Polling | Removed while the stream is open; a 60-second poll only while it is not. The stream is the fast path, the poll the floor |
| LU7 | Agents | No stream for MCP tokens. Agents ask when they need to; nothing an agent does is time-critical |

## Checkpoint

Live updates are done when, provably and repeatably:

1. A violation recorded by the engine appears on an open Violations
   page and in the Overview counts within two seconds, with no poll
   running.
2. With five tabs open, the engine sees exactly one stream client.
3. Killing the engine's stream connection (engine left running) leads
   to a reconnect and a `resync` in every tab; a violation recorded
   during the gap is on screen after the resync.
4. A browser that stops reading (paused tab, throttled socket) is sent
   `resync` with reason `behind` and closed; its queue never exceeds
   256 events, and other tabs are unaffected.
5. A session revoked in Settings closes that session's streams; the
   tab lands on `/login`. An MCP token on `/api/v1/events` gets `401`.
6. On a chain producing four blocks a second, the browser receives at
   most one `block` event a second.
7. Stopping the engine shows `health` with `stopped` or `restarting`
   within a second of the supervisor noticing, with the upstream
   connection gone; the Overview's health strip changes without a
   refresh.
8. Behind a reverse proxy with default buffering, events arrive as
   written, and an idle stream survives ten minutes.
