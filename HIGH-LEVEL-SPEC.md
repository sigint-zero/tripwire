# High-Level Spec

The `tripwire` application: the command line, local server, and web
dashboard for operating a Tripwire engine. This document is the top-level
map; detailed specs land alongside the code they describe.

## Overview

The application is what a user installs and interacts with. It owns
everything human-facing: installation and setup, the dashboard, the local
HTTP API, and the command line. The engine, a native binary the
application installs and supervises, owns detection, response and the
database. The application never talks to the chain and never holds key
material; it displays state and carries the user's intent to the engine.

## Components

One repository, one workspace, five packages:

| Package | Role |
|-|-|
| `cli` | the `tripwire` command: guided setup, starting and supervising the engine and server together, and utilities (rule export/import, key and token management) |
| `server` | the local HTTP API. Serves the dashboard, exposes `/api/v1` for the dashboard and for user scripts, streams live events, forwards commands to the engine |
| `web` | the dashboard: a single-page app built to static files, served by the server |
| `shared` | types and validation schemas used by all packages |
| `engine-stub` | development stand-in for the engine: same interface, fixture data, scripted scenarios. Lets the whole application run with no engine present |

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
| Dashboard | counts, tripped-now, recent violations, pinned charts, system health |
| Contracts | registered contracts, live state, per-contract invariants and history |
| Invariants | all rules with current values and status; a template-driven wizard to create and edit them; per-rule detail with charts and evidence |
| Violations | filterable history with full evidence per violation |
| Responses | the approval queue for prepared response transactions, and response history |
| Activity | timeline of on-chain trip events and role changes |
| Notifications | in-app feed and alert-channel status |
| Settings | connection readout, response defaults, retention, alert channels, keys and tokens, response-mode onboarding |
| First run | guided setup from RPC endpoint to first rule and first alert channel |

## Technology

TypeScript throughout, strict. Fastify for the server. React with Vite
for the dashboard, TanStack Query for data, hand-rolled SVG for charts.
Zod validation at every boundary. pnpm workspaces, vitest.

## Status

Pre-implementation. This spec leads the code and will be revised as the
application takes shape.
