-- Enable RLS on all bot tables that were missing it and tighten existing policies.
-- All bot data is private to authenticated users only.
-- The NEXT_PUBLIC_SUPABASE_ANON_KEY is visible in the browser bundle, so these tables
-- must require authentication to prevent direct API access by anyone with the key.

-- ─── Tables with RLS completely off ──────────────────────────────────────────

ALTER TABLE bot_candles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read bot candles"
  ON bot_candles FOR SELECT TO authenticated USING (true);

ALTER TABLE bot_incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read bot incidents"
  ON bot_incidents FOR SELECT TO authenticated USING (true);

ALTER TABLE bot_paper_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read bot paper trades"
  ON bot_paper_trades FOR SELECT TO authenticated USING (true);

ALTER TABLE bot_parameter_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read bot parameter history"
  ON bot_parameter_history FOR SELECT TO authenticated USING (true);

ALTER TABLE bot_strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read bot strategies"
  ON bot_strategies FOR SELECT TO authenticated USING (true);

ALTER TABLE bot_strategy_parameters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read bot strategy parameters"
  ON bot_strategy_parameters FOR SELECT TO authenticated USING (true);

ALTER TABLE bot_tuning_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read bot tuning runs"
  ON bot_tuning_runs FOR SELECT TO authenticated USING (true);

-- ─── bot_settings: RLS was off despite having a dead policy ──────────────────

ALTER TABLE bot_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can read bot settings" ON bot_settings;
CREATE POLICY "Authenticated users can read bot settings"
  ON bot_settings FOR SELECT TO authenticated USING (true);

-- ─── bot_premium_decay_points: tighten from public to authenticated ───────────

DROP POLICY IF EXISTS "Public can read bot premium decay points" ON bot_premium_decay_points;
CREATE POLICY "Authenticated users can read bot premium decay points"
  ON bot_premium_decay_points FOR SELECT TO authenticated USING (true);
