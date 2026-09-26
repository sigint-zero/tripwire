# High-Level Spec

The `tripwire` application: the command line, local server, and web
dashboard for operating a Tripwire engine. This document is the top-level
map; detailed specs land in this folder.

## Overview

The application is what a user installs and interacts with. It owns
everything human-facing: installation and setup, the dashboard, the local
HTTP API, and the command line. The engine, a native binary the
application installs and supervises, owns detection, response and the
database. The application never talks to the chain and never holds key
material; it displays state and carries the user's intent to the engine.

A **rule** is one watchable statement about a contract: a condition that
should never occur and what to do when it does. Most rules encode
invariants, properties that must always hold; others watch for
occurrences such as an ownership transfer or a stale oracle. "Rule" is
the word everywhere in the application; "invariant" names only that
first class of rule.

## Components

One repository, one workspace, six packages:

| Package | Role |
|-|-|
| `cli` | the `tripwire` command: guided setup, starting and supervising the engine and server together, and utilities (rule export/import, key and token management) |
| `server` | the local HTTP API. Serves the dashboard, exposes `/api/v1` for the dashboard and for user scripts, streams live events, forwards commands to the engine |
| `web` | the dashboard: a single-page app built to static files, served by the server |
| `shared` | types and validation schemas used by all packages |
| `engine-stub` | development stand-in for the engine: same interface, fixture data, scripted scenarios. Lets the whole application run with no engine present |
| `mcp` | a Model Context Protocol server exposing Tripwire to AI agents: it teaches an agent how to find a contract's rules, shows contracts and the rules already on them, and accepts rule submissions checked by the engine. Specified in `MCP-SERVER.md` |

## How data moves

- **Reads**: the server queries the engine's database views and shapes the
  results for the dashboard. Charts, lists and evidence all come from
  here.
- **Commands**: anything that changes state (create a rule, approve a
  response, manage a key) is forwarded to the engine over its local
  interface. The engine validates and executes; the application never
  writes state itself.
- **Live updates**: the server relays the engine's event stream to the
  dashboard, so violations, trip state and health appear without refresh.

## The dashboard

| Area | Purpose |
|-|-|
| Overview | counts, tripped-now, recent violations, pinned charts, system health |
| Contracts | registered contracts, live state, per-contract rules and history |
| Rules | all rules with current values and status; a wizard with starting points to create and edit them; per-rule detail with charts and evidence |
| Violations | filterable history with full evidence per violation |
| Responses | the approval queue for prepared response transactions, and response history |
| Activity | timeline of on-chain trip events and role changes |
| Notifications | in-app feed and alert-channel status |
| Settings | connection readout, response defaults, retention, alert channels, keys and tokens, response-mode onboarding |
| First run | guided setup from account creation and RPC endpoint to first rule and first alert channel |
| Login | username and password; sessions last a day |

## AI agents

Tripwire ships no model and no chat. Instead it exposes a Model Context
Protocol server, and users point their own AI agent at it. The MCP server
is self-describing: it teaches a connected agent what Tripwire is, what a
rule is, and how rules are found and constructed, so the agent can:

1. **Understand the system**: read the registered contracts (ABI, verified
   source, live values, the addresses they depend on) and the rules
   already watching them.
2. **Draft rules**: build rules against the engine's rule schema and check
   them against the live chain before proposing anything.
3. **Submit them**: through the same validated path the wizard uses.
   Agent-submitted rules arrive disabled and notify-only, and are
   enabled by a person in the dashboard.

That is the whole surface for now; `MCP-SERVER.md` specifies it.

## Access

The server requires a login: a username and password exchanged for a
session, created on first run. AI agents authenticate to the MCP
endpoint with a token a logged-in person mints for them, and that token
opens nothing else. `AUTHENTICATION.md` specifies both.

## Technology

TypeScript throughout, strict. Fastify for the server. React with Vite
for the dashboard, TanStack Query for data, hand-rolled SVG for charts.
Zod validation at every boundary. pnpm workspaces, vitest.

## Status

Pre-implementation. This spec leads the code and will be revised as the
application takes shape.
