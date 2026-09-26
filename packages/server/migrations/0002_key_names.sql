-- What people call the keys the engine signs with (RESPONSES.md, Keys).
-- Kept by address and never swept: a key's file can be put back, and its
-- name comes back with it.
CREATE TABLE app.key_names (
  address text PRIMARY KEY CHECK (address = lower(address)),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  named_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
