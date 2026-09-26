-- The application's own schema: everything it remembers that is not a
-- credential (DATABASE.md, NOTIFICATIONS.md). Engine objects are named by
-- their id or address with no foreign key across schemas; rows that
-- outlive what they name are swept.

CREATE SCHEMA app;

-- The runner's ledger.
CREATE TABLE app.migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Settings too small for a table of their own.
CREATE TABLE app.settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Notifications recorded before the first start are shown, never sent.
INSERT INTO app.settings (key, value)
VALUES ('notifications.dispatch_since', to_jsonb(now()));

-- How a rule's values are shown.
CREATE TABLE app.rule_prefs (
  rule_id bigint PRIMARY KEY,
  display_decimals integer,
  display_unit text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Rules stored by an MCP token: the "created via MCP" badge and the
-- volume guard, which counts a token's rows in the trailing hour.
CREATE TABLE app.rule_submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id bigint NOT NULL,
  token_id text NOT NULL,
  token_label text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rule_submissions_by_token ON app.rule_submissions (token_id, submitted_at);

-- Violations a person has acknowledged.
CREATE TABLE app.violation_acks (
  violation_id bigint PRIMARY KEY,
  acknowledged_by text NOT NULL,
  note text,
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);

-- Disabled contracts, with exactly the rules the disabling switched off.
CREATE TABLE app.contract_disables (
  contract_id bigint PRIMARY KEY,
  rule_ids bigint[] NOT NULL,
  disabled_by text NOT NULL,
  disabled_at timestamptz NOT NULL DEFAULT now()
);

-- Verified source fetched when a contract was added.
CREATE TABLE app.contract_sources (
  address text PRIMARY KEY CHECK (address = lower(address)),
  verified boolean NOT NULL,
  compiler text,
  implementation text,
  files jsonb NOT NULL,
  fetched_from text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- What people call the keys the engine signs with (RESPONSES.md, Keys).
-- Kept by address and never swept: a key's file can be put back, and its
-- name comes back with it.
CREATE TABLE app.key_names (
  address text PRIMARY KEY CHECK (address = lower(address)),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  named_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Alert channels; their secrets stay in channel-secrets.json.
CREATE TABLE app.channels (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  type text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  kinds text[] NOT NULL,
  min_severity text NOT NULL DEFAULT 'info'
    CHECK (min_severity IN ('info', 'warning', 'critical')),
  storm_limit integer NOT NULL DEFAULT 10 CHECK (storm_limit >= 0),
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The application's own system notifications, beside the engine's.
CREATE TABLE app.local_notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Notifications already fanned out to channels.
CREATE TABLE app.dispatches (
  source text NOT NULL CHECK (source IN ('engine', 'app')),
  notification_id bigint NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, notification_id)
);

-- One notification to one channel. No key to the channel: deleting a
-- channel deletes its undelivered rows, and delivered ones age out.
CREATE TABLE app.deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('engine', 'app')),
  notification_id bigint NOT NULL,
  channel_id bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  digest_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_due ON app.deliveries (next_attempt_at)
  WHERE delivered_at IS NULL;

-- In-app read state, shared by all accounts.
CREATE TABLE app.notification_reads (
  source text NOT NULL CHECK (source IN ('engine', 'app')),
  notification_id bigint NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, notification_id)
);
