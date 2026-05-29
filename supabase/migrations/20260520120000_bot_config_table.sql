-- Create bot_config table for trading control and circuit breaker state
CREATE TABLE IF NOT EXISTS bot_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  trading_enabled BOOLEAN DEFAULT true,
  circuit_breaker_triggered_at TIMESTAMP WITH TIME ZONE,
  last_trading_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Ensure only one row exists
ALTER TABLE bot_config ADD CONSTRAINT single_row CHECK (id = 1);

-- Add RLS policy
ALTER TABLE bot_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access" ON bot_config
  USING (true)
  WITH CHECK (true);
