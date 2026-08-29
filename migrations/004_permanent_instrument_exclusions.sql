-- Persistent instrument exclusions after three separate bans.
ALTER TABLE instrument_analytics
  ADD COLUMN IF NOT EXISTS permanently_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE instrument_analytics
  ADD COLUMN IF NOT EXISTS excluded_at timestamptz DEFAULT NULL;
ALTER TABLE instrument_analytics
  ADD COLUMN IF NOT EXISTS ban_count integer NOT NULL DEFAULT 0;