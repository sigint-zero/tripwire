// Every engine operation the application calls, with every response status
// the pinned engine documents for it and what the application does with
// that status. A status the engine starts
// documenting fails the parity test until it is added here with its
// meaning. Statuses the engine returns without documenting them, which a
// route handles on purpose, are listed as well.
//
// Refusals keep their status and code on the way to the dashboard
// (api.ts, the error handler), unless a route says otherwise.

export const ENGINE_OPERATIONS: Record<string, Record<string, string>> = {
  "GET /v1/health": { "200": "the engine's own health, polled" },
  "GET /v1/events": { "200": "the event stream, relayed to the dashboard" },
  "POST /v1/contracts": { "201": "registered" },
  "PATCH /v1/contracts/{address}": { "200": "renamed or new ABI stored" },
  "DELETE /v1/contracts/{address}": {
    "204": "removed; the application forgets its own data about it",
    "409": "one of its rules has a live response: kept, and the refusal shown",
  },
  "POST /v1/rules": {
    "201": "stored",
    "400": "the document's issues, shown on their fields",
  },
  "PUT /v1/rules/{id}": {
    "200": "replaced",
    "400": "the document's issues, shown on their fields",
  },
  "PATCH /v1/rules/{id}": { "200": "switched on or off" },
  "POST /v1/rules/enabled": { "200": "switched on or off together" },
  "DELETE /v1/rules/{id}": {
    "204": "removed; the application forgets its own data about it",
    "409": "it has a live response: kept, and the refusal shown",
  },
  "POST /v1/rules/dry-run": {
    "200": "the check's verdict",
    "400": "the document's issues, shown on their fields",
  },
  "POST /v1/read": { "200": "live values for the wizard" },
  "POST /v1/responses/{id}/approve": {
    "200": "submitted",
    "409":
      "busy: stays waiting (409 busy); else no longer waiting (409 not_waiting)",
  },
  "POST /v1/responses/{id}/reject": {
    "200": "abandoned",
    "409": "no longer waiting (409 not_waiting)",
  },
  "POST /v1/responses/dry-run": { "200": "the action built and simulated" },
  "GET /v1/keys": { "200": "the keys" },
  "POST /v1/keys": { "201": "created" },
  "POST /v1/keys/import": { "201": "imported" },
  "POST /v1/keys/{address}/unlock": { "200": "unlocked" },
  "POST /v1/keys/{address}/lock": { "200": "locked" },
  "POST /v1/actions": { "201": "submitted" },
};
