export type AlertDirection = "bullish" | "bearish";
export type AlertStatus = "active" | "expired" | "invalidated";
export type ShadowTradeSide = "long" | "short";
export type ShadowTradeStatus = "open" | "closed" | "cancelled";

export type ScoreFactor = {
  name: string;
  score: number;
  state: string;
};

export type AlertFeedItem = {
  id: string;
  instrument_id: string;
  symbol: string;
  exchange: string;
  instrument_name: string;
  alert_type: string;
  direction: AlertDirection;
  title: string;
  thesis: string;
  trigger_price: number;
  current_price: number;
  vwap: number | null;
  swept_level: number;
  swept_level_name: string;
  volume_multiplier: number;
  conviction_score: number;
  score_factors: ScoreFactor[];
  timeframe_alignment: Record<string, string>;
  market_session: string;
  status: AlertStatus;
  detected_at: string;
  expires_at: string | null;
};

export type ShadowTradePosition = {
  id: string;
  user_id: string;
  alert_id: string | null;
  instrument_id: string;
  symbol: string;
  exchange: string;
  instrument_name: string;
  side: ShadowTradeSide;
  quantity: number;
  entry_price: number;
  current_price: number;
  exit_price: number | null;
  entry_reason: string;
  exit_reason: string | null;
  status: ShadowTradeStatus;
  opened_at: string;
  closed_at: string | null;
  unrealized_pnl: number;
  pnl_percent: number;
};
