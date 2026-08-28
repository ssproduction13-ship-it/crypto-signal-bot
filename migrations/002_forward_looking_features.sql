-- Forward-looking feature experiments. Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS shadow_features (
  id serial PRIMARY KEY,
  feature_name text NOT NULL,
  symbol text NOT NULL,
  payload jsonb NOT NULL,
  trade_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_features_name
  ON shadow_features(feature_name, created_at);

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS shadow_feature_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE paper_closed_trades
  ADD COLUMN IF NOT EXISTS llm_news_sentiment text;
ALTER TABLE paper_closed_trades
  ADD COLUMN IF NOT EXISTS llm_risk_level text;
ALTER TABLE paper_closed_trades
  ADD COLUMN IF NOT EXISTS llm_agreed boolean;