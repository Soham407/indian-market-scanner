#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
import os
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATA_DIR = REPO_ROOT / "quant-lab" / "data" / "raw" / "intraday"
DEFAULT_REPORT_DIR = REPO_ROOT / "quant-lab" / "reports"

IST = "Asia/Kolkata"

BASE_RISK_AMOUNT = 1000.0
DEFAULT_RISK_MULTIPLIER = 0.25

ENTRY_SLIPPAGE_PCT = 0.0005
TARGET_EXIT_SLIPPAGE_PCT = 0.0005
STOP_EXIT_SLIPPAGE_PCT = 0.0010
EOD_EXIT_SLIPPAGE_PCT = 0.0005
BROKERAGE_PER_TRADE = 40.0
STATUTORY_FEE_PCT = 0.0005

STRESS_START = pd.Timestamp("2015-01-01", tz=IST)
TRAIN_START = pd.Timestamp("2020-01-01", tz=IST)
VALIDATION_START = pd.Timestamp("2021-01-01", tz=IST)
HOLDOUT_START = pd.Timestamp("2026-01-01", tz=IST)

NIFTY50_TICKERS = {
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK",
    "BAJAJ-AUTO", "BAJAJFINANCE", "BAJAJFINSV", "BPCL", "BHARTIARTL",
    "BRITANNIA", "CIPLA", "COALINDIA", "DIVISLAB", "DRREDDY",
    "EICHERMOT", "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE",
    "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK", "ITC",
    "INDUSINDBK", "INFY", "JSWSTEEL", "KOTAKBANK", "LTIM",
    "LT", "M&M", "MARUTI", "NTPC", "NESTLEIND",
    "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SBIN",
    "SUNPHARMA", "TCS", "TATACONSUM", "TATAMOTORS", "TATASTEEL",
    "TECHM", "TITAN", "ULTRACEMCO", "UPL", "WIPRO",
}


@dataclass(frozen=True)
class Coverage:
    symbol: str
    file: str
    first_ts: str
    last_ts: str
    bars: int
    days: int


@dataclass(frozen=True)
class StrategyVariant:
    strategy: str
    parameters: dict[str, Any]


def make_tz(ts: str | pd.Timestamp) -> pd.Timestamp:
    return pd.Timestamp(ts).tz_convert(IST) if pd.Timestamp(ts).tzinfo else pd.Timestamp(ts, tz=IST)


def classify_split(ts: pd.Timestamp) -> str:
    if ts < TRAIN_START:
        return "stress"
    if ts < VALIDATION_START:
        return "discovery"
    if ts < HOLDOUT_START:
        return "validation"
    return "holdout"


def to_report_dt(value: pd.Timestamp | datetime | str) -> str:
    ts = pd.Timestamp(value)
    if ts.tzinfo is None:
        ts = ts.tz_localize(IST)
    return ts.isoformat()


def load_symbol_frame(path: Path) -> tuple[pd.DataFrame | None, Coverage | None]:
    try:
        df = pd.read_csv(path)
    except Exception as exc:
        print(f"Skipping {path.name}: {exc}")
        return None, None

    if df.empty:
        return None, None

    df.columns = [c.strip().lower() for c in df.columns]
    time_col = next((c for c in df.columns if c in ("date", "datetime", "timestamp", "time")), None)
    if time_col is None:
        print(f"Skipping {path.name}: missing datetime column")
        return None, None

    rename_map = {
        "open": "Open",
        "high": "High",
        "low": "Low",
        "close": "Close",
        "volume": "Volume",
    }
    df = df.rename(columns=rename_map)
    required = ["Open", "High", "Low", "Close", "Volume"]
    if any(col not in df.columns for col in required):
        print(f"Skipping {path.name}: missing OHLCV columns")
        return None, None

    for col in required:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=required)

    timestamps = pd.to_datetime(df[time_col], utc=True, errors="coerce")
    df = df.loc[timestamps.notna()].copy()
    timestamps = timestamps.loc[timestamps.notna()].dt.tz_convert(IST)
    df.index = timestamps
    df.index.name = "timestamp"
    df = df.sort_index()
    df = df[~df.index.duplicated(keep="last")]

    symbol = path.stem.replace("_5m", "")
    df["Symbol"] = symbol

    coverage = Coverage(
        symbol=symbol,
        file=str(path),
        first_ts=to_report_dt(df.index.min()),
        last_ts=to_report_dt(df.index.max()),
        bars=len(df),
        days=df.index.normalize().nunique(),
    )
    return df, coverage


def build_universe(data_dir: Path, universe: str, symbols: list[str] | None) -> list[Path]:
    paths = sorted(data_dir.glob("*_5m.csv"))
    if universe == "nifty50":
        allowed = {ticker for ticker in NIFTY50_TICKERS}
        paths = [path for path in paths if path.stem.replace("_5m", "") in allowed]
    if symbols:
        requested = {s.strip().upper() for s in symbols if s.strip()}
        paths = [path for path in paths if path.stem.replace("_5m", "") in requested]
    return paths


def enrich_intraday_frame(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    session = out.index.normalize()
    out["session_date"] = session

    typical_price = (out["High"] + out["Low"] + out["Close"]) / 3.0
    out["cum_tp_vol"] = (typical_price * out["Volume"]).groupby(session).cumsum()
    out["cum_vol"] = out["Volume"].groupby(session).cumsum().replace(0, np.nan)
    out["VWAP"] = out["cum_tp_vol"] / out["cum_vol"]
    out["vol_sma_5"] = out["Volume"].shift(1).rolling(5, min_periods=1).mean()
    out["vol_sma_20"] = out["Volume"].shift(1).rolling(20, min_periods=1).mean()
    out["bar_in_day"] = out.groupby(session).cumcount()

    daily = out.groupby(session).agg(
        day_open=("Open", "first"),
        day_high=("High", "max"),
        day_low=("Low", "min"),
        day_close=("Close", "last"),
        day_volume=("Volume", "sum"),
    )
    daily["prev_high"] = daily["day_high"].shift(1)
    daily["prev_low"] = daily["day_low"].shift(1)
    daily["prev_close"] = daily["day_close"].shift(1)
    daily["prev_open"] = daily["day_open"].shift(1)
    daily["prev_volume"] = daily["day_volume"].shift(1)

    out = out.join(daily[["prev_high", "prev_low", "prev_close", "prev_open", "prev_volume"]], on="session_date")
    return out


def apply_entry_slippage(side: str, trigger_price: float) -> float:
    raw = trigger_price * (1 + ENTRY_SLIPPAGE_PCT) if side == "long" else trigger_price * (1 - ENTRY_SLIPPAGE_PCT)
    return round(raw, 4)


def apply_exit_slippage(side: str, exit_price: float, exit_reason: str) -> float:
    slip = STOP_EXIT_SLIPPAGE_PCT if exit_reason == "stop" else TARGET_EXIT_SLIPPAGE_PCT if exit_reason == "target" else EOD_EXIT_SLIPPAGE_PCT
    if side == "long":
        return round(exit_price * (1 - slip), 4)
    return round(exit_price * (1 + slip), 4)


def calculate_shares(risk_amount: float, entry_price: float, stop_price: float) -> int:
    risk_per_share = abs(entry_price - stop_price)
    if risk_per_share <= 0:
        return 0
    return math.floor(risk_amount / risk_per_share)


def risk_target(trigger_price: float, stop_price: float, side: str, target_mult: float) -> float:
    risk = abs(trigger_price - stop_price)
    if side == "long":
        return round(trigger_price + (risk * target_mult), 4)
    return round(trigger_price - (risk * target_mult), 4)


def compute_pnl(side: str, entry_price: float, exit_price: float, shares: int) -> tuple[float, float, float]:
    gross = (exit_price - entry_price) * shares if side == "long" else (entry_price - exit_price) * shares
    statutory = abs(exit_price * shares * STATUTORY_FEE_PCT)
    net = gross - statutory - BROKERAGE_PER_TRADE
    return gross, statutory, net


def trade_mfe_mae(day_df: pd.DataFrame, entry_idx: int, side: str, entry_price: float) -> tuple[float | None, float | None]:
    future = day_df.iloc[entry_idx + 1 :]
    if future.empty:
        return None, None
    if side == "long":
        mfe = future["High"].max() - entry_price
        mae = entry_price - future["Low"].min()
    else:
        mfe = entry_price - future["Low"].min()
        mae = future["High"].max() - entry_price
    return float(mfe), float(mae)


def simulate_trade(
    day_df: pd.DataFrame,
    signal_idx: int,
    side: str,
    stop_price: float,
    target_price: float,
    strategy: str,
    parameters: dict[str, Any],
    signal_reason: str,
    risk_multiplier: float = DEFAULT_RISK_MULTIPLIER,
) -> dict[str, Any] | None:
    if signal_idx >= len(day_df) - 1:
        return None

    signal_row = day_df.iloc[signal_idx]
    trigger_price = float(signal_row["Close"])
    entry_price = apply_entry_slippage(side, trigger_price)
    risk_amount = BASE_RISK_AMOUNT * risk_multiplier
    shares = calculate_shares(risk_amount, entry_price, stop_price)
    if shares <= 0:
        return None

    exit_price = None
    exit_reason = None
    exit_time = None

    future = day_df.iloc[signal_idx + 1 :]
    for ts, candle in future.iterrows():
        if side == "long":
            if candle["Low"] <= stop_price:
                exit_price = stop_price
                exit_reason = "stop"
                exit_time = ts
                break
            if candle["High"] >= target_price:
                exit_price = target_price
                exit_reason = "target"
                exit_time = ts
                break
        else:
            if candle["High"] >= stop_price:
                exit_price = stop_price
                exit_reason = "stop"
                exit_time = ts
                break
            if candle["Low"] <= target_price:
                exit_price = target_price
                exit_reason = "target"
                exit_time = ts
                break

    if exit_price is None:
        last = future.iloc[-1]
        exit_time = future.index[-1]
        exit_price = float(last["Close"])
        exit_reason = "eod"

    exit_price = apply_exit_slippage(side, float(exit_price), exit_reason)
    gross_pnl, statutory_charges, net_pnl = compute_pnl(side, entry_price, exit_price, shares)
    duration_minutes = int(max(0, round((pd.Timestamp(exit_time) - pd.Timestamp(signal_row.name)).total_seconds() / 60)))
    mfe, mae = trade_mfe_mae(day_df, signal_idx, side, entry_price)

    return {
        "strategy": strategy,
        "parameters": parameters,
        "signal_reason": signal_reason,
        "symbol": signal_row["Symbol"],
        "side": side,
        "entry_time": to_report_dt(signal_row.name),
        "exit_time": to_report_dt(exit_time),
        "exit_reason": exit_reason,
        "trigger_price": round(trigger_price, 4),
        "entry_price": round(entry_price, 4),
        "exit_price": round(exit_price, 4),
        "stop_loss_price": round(stop_price, 4),
        "target_price": round(target_price, 4),
        "shares": shares,
        "risk_amount": round(risk_amount, 4),
        "gross_pnl": round(gross_pnl, 4),
        "statutory_charges": round(statutory_charges, 4),
        "brokerage": BROKERAGE_PER_TRADE,
        "net_pnl": round(net_pnl, 4),
        "duration_minutes": duration_minutes,
        "mfe": None if mfe is None else round(mfe, 4),
        "mae": None if mae is None else round(mae, 4),
    }


def first_signal(day_df: pd.DataFrame, mask: pd.Series, side: str, stop_price: float, target_price: float, strategy: str, parameters: dict[str, Any], signal_reason: str, risk_multiplier: float = DEFAULT_RISK_MULTIPLIER) -> dict[str, Any] | None:
    hits = np.flatnonzero(mask.to_numpy(dtype=bool))
    if len(hits) == 0:
        return None
    return simulate_trade(day_df, int(hits[0]), side, stop_price, target_price, strategy, parameters, signal_reason, risk_multiplier=risk_multiplier)


def strategy_orb_breakout(day_df: pd.DataFrame, parameters: dict[str, Any]) -> list[dict[str, Any]]:
    if len(day_df) < 4:
        return []
    buffer_pct = float(parameters["breakout_buffer"])
    target_mult = float(parameters["target_multiplier"])
    vol_mult = float(parameters.get("vol_mult", 1.5))
    morning_end = min(3, len(day_df))
    or_high = float(day_df.iloc[:morning_end]["High"].max())
    or_low = float(day_df.iloc[:morning_end]["Low"].min())
    or_range = or_high - or_low
    if or_range <= 0:
        return []

    future = day_df.iloc[morning_end:].copy()
    if future.empty:
        return []

    long_mask = (
        (future["Close"] > or_high * (1 + buffer_pct)) &
        (future["Close"] > future["VWAP"] * 1.001) &
        (future["Volume"] > future["vol_sma_5"] * vol_mult)
    )
    short_mask = (
        (future["Close"] < or_low * (1 - buffer_pct)) &
        (future["Close"] < future["VWAP"] * 0.999) &
        (future["Volume"] > future["vol_sma_5"] * vol_mult)
    )

    trades = []
    long_hits = np.flatnonzero(long_mask.to_numpy(dtype=bool))
    if len(long_hits) > 0:
        long_idx = int(long_hits[0])
        long_trigger = float(future.iloc[long_idx]["Close"])
        long_stop = or_low
        long_trade = simulate_trade(
            future,
            long_idx,
            "long",
            long_stop,
            risk_target(long_trigger, long_stop, "long", target_mult),
            "orb_breakout",
            parameters,
            "orb_momentum_long",
        )
        if long_trade:
            trades.append(long_trade)

    short_hits = np.flatnonzero(short_mask.to_numpy(dtype=bool))
    if len(short_hits) > 0:
        short_idx = int(short_hits[0])
        short_trigger = float(future.iloc[short_idx]["Close"])
        short_stop = or_high
        short_trade = simulate_trade(
            future,
            short_idx,
            "short",
            short_stop,
            risk_target(short_trigger, short_stop, "short", target_mult),
            "orb_breakout",
            parameters,
            "orb_momentum_short",
        )
        if short_trade:
            trades.append(short_trade)

    return trades


def strategy_or_trap(day_df: pd.DataFrame, parameters: dict[str, Any]) -> list[dict[str, Any]]:
    if len(day_df) < 4:
        return []
    buffer_pct = float(parameters["breakout_buffer"])
    target_mult = float(parameters["target_multiplier"])
    morning_end = min(3, len(day_df))
    or_high = float(day_df.iloc[:morning_end]["High"].max())
    or_low = float(day_df.iloc[:morning_end]["Low"].min())
    or_range = or_high - or_low
    future = day_df.iloc[morning_end:].copy()
    if future.empty or or_range <= 0:
        return []

    shorts = (
        (future["High"] > or_high * (1 + buffer_pct)) &
        (future["Close"] < or_high) &
        (future["Close"] < future["VWAP"])
    )
    longs = (
        (future["Low"] < or_low * (1 - buffer_pct)) &
        (future["Close"] > or_low) &
        (future["Close"] > future["VWAP"])
    )

    trades = []
    short_hits = np.flatnonzero(shorts.to_numpy(dtype=bool))
    if len(short_hits) > 0:
        short_idx = int(short_hits[0])
        short_trigger = float(future.iloc[short_idx]["Close"])
        short_stop = float(future.iloc[short_idx]["High"]) * 1.001
        short_trade = simulate_trade(
            future,
            short_idx,
            "short",
            short_stop,
            risk_target(short_trigger, short_stop, "short", target_mult),
            "or_trap",
            parameters,
            "or_failed_breakout_short",
        )
        if short_trade:
            trades.append(short_trade)

    long_hits = np.flatnonzero(longs.to_numpy(dtype=bool))
    if len(long_hits) > 0:
        long_idx = int(long_hits[0])
        long_trigger = float(future.iloc[long_idx]["Close"])
        long_stop = float(future.iloc[long_idx]["Low"]) * 0.999
        long_trade = simulate_trade(
            future,
            long_idx,
            "long",
            long_stop,
            risk_target(long_trigger, long_stop, "long", target_mult),
            "or_trap",
            parameters,
            "or_failed_breakout_long",
        )
        if long_trade:
            trades.append(long_trade)

    return trades


def strategy_pdh_pdl_trap(day_df: pd.DataFrame, parameters: dict[str, Any]) -> list[dict[str, Any]]:
    if len(day_df) < 2 or pd.isna(day_df.iloc[0]["prev_high"]) or pd.isna(day_df.iloc[0]["prev_low"]):
        return []
    displacement = float(parameters.get("displacement", 0.0075))
    target_mult = float(parameters["target_multiplier"])
    vwap = day_df["VWAP"].copy()

    short_mask = (
        (day_df["High"] >= day_df["prev_high"]) &
        (day_df["Close"] < day_df["prev_high"]) &
        (day_df["Close"] > vwap * (1 + displacement))
    )
    long_mask = (
        (day_df["Low"] <= day_df["prev_low"]) &
        (day_df["Close"] > day_df["prev_low"]) &
        (day_df["Close"] < vwap * (1 - displacement))
    )

    trades = []
    short_hits = np.flatnonzero(short_mask.to_numpy(dtype=bool))
    if len(short_hits) > 0:
        short_idx = int(short_hits[0])
        short_trigger = float(day_df.iloc[short_idx]["Close"])
        short_stop = float(day_df.iloc[short_idx]["High"]) * 1.001
        short_trade = simulate_trade(
            day_df,
            short_idx,
            "short",
            short_stop,
            risk_target(short_trigger, short_stop, "short", target_mult),
            "pdh_pdl_trap",
            parameters,
            "pdh_trap_short",
        )
        if short_trade:
            trades.append(short_trade)

    long_hits = np.flatnonzero(long_mask.to_numpy(dtype=bool))
    if len(long_hits) > 0:
        long_idx = int(long_hits[0])
        long_trigger = float(day_df.iloc[long_idx]["Close"])
        long_stop = float(day_df.iloc[long_idx]["Low"]) * 0.999
        long_trade = simulate_trade(
            day_df,
            long_idx,
            "long",
            long_stop,
            risk_target(long_trigger, long_stop, "long", target_mult),
            "pdh_pdl_trap",
            parameters,
            "pdl_bounce_long",
        )
        if long_trade:
            trades.append(long_trade)

    return trades


def strategy_gap_reversal(day_df: pd.DataFrame, parameters: dict[str, Any]) -> list[dict[str, Any]]:
    if len(day_df) < 2 or pd.isna(day_df.iloc[0]["prev_close"]):
        return []
    gap_pct = float(parameters["gap_pct"])
    target_mult = float(parameters["target_multiplier"])
    first = day_df.iloc[0]
    gap_up = first["Open"] >= first["prev_close"] * (1 + gap_pct)
    gap_down = first["Open"] <= first["prev_close"] * (1 - gap_pct)
    first_bar_close_below_open = first["Close"] < first["Open"]
    first_bar_close_above_open = first["Close"] > first["Open"]

    if gap_up and first_bar_close_below_open and first["Close"] < first["prev_close"]:
        stop = float(first["High"]) * 1.001
        target = risk_target(float(first["Close"]), stop, "short", target_mult)
        trade = simulate_trade(day_df, 0, "short", stop, target, "gap_reversal", parameters, "gap_up_reversal")
        return [trade] if trade else []
    if gap_down and first_bar_close_above_open and first["Close"] > first["prev_close"]:
        stop = float(first["Low"]) * 0.999
        target = risk_target(float(first["Close"]), stop, "long", target_mult)
        trade = simulate_trade(day_df, 0, "long", stop, target, "gap_reversal", parameters, "gap_down_reversal")
        return [trade] if trade else []
    return []


def strategy_gap_and_go(day_df: pd.DataFrame, parameters: dict[str, Any]) -> list[dict[str, Any]]:
    if len(day_df) < 3 or pd.isna(day_df.iloc[0]["prev_close"]):
        return []
    gap_pct = float(parameters["gap_pct"])
    target_mult = float(parameters["target_multiplier"])
    vol_mult = float(parameters.get("vol_mult", 1.2))
    first = day_df.iloc[0]
    first3 = day_df.iloc[:3]
    prev_volume = float(first["prev_volume"]) if pd.notna(first["prev_volume"]) else float(first3["Volume"].sum())
    rel_vol = first3["Volume"].sum() / max(1.0, prev_volume)
    gap_up = first["Open"] >= first["prev_close"] * (1 + gap_pct)
    gap_down = first["Open"] <= first["prev_close"] * (1 - gap_pct)

    if gap_up and first3["Close"].min() > first["Open"] and first3["Close"].iloc[-1] > first["prev_close"] and rel_vol >= vol_mult:
        stop = float(first3["Low"].min()) * 0.999
        target = risk_target(float(first3["Close"].iloc[-1]), stop, "long", target_mult)
        trade = simulate_trade(day_df, 2, "long", stop, target, "gap_and_go", parameters, "gap_up_go")
        return [trade] if trade else []

    if gap_down and first3["Close"].max() < first["Open"] and first3["Close"].iloc[-1] < first["prev_close"] and rel_vol >= vol_mult:
        stop = float(first3["High"].max()) * 1.001
        target = risk_target(float(first3["Close"].iloc[-1]), stop, "short", target_mult)
        trade = simulate_trade(day_df, 2, "short", stop, target, "gap_and_go", parameters, "gap_down_go")
        return [trade] if trade else []

    return []


def strategy_vwap_reclaim_rejection(day_df: pd.DataFrame, parameters: dict[str, Any]) -> list[dict[str, Any]]:
    if len(day_df) < 2:
        return []
    displacement = float(parameters["displacement"])
    target_mult = float(parameters["target_multiplier"])
    vol_mult = float(parameters.get("vol_mult", 1.2))

    short_mask = (
        (day_df["High"] >= day_df["VWAP"] * (1 + displacement)) &
        (day_df["Close"] < day_df["VWAP"]) &
        (day_df["Close"] < day_df["Open"]) &
        (day_df["Volume"] > day_df["vol_sma_5"] * vol_mult)
    )
    long_mask = (
        (day_df["Low"] <= day_df["VWAP"] * (1 - displacement)) &
        (day_df["Close"] > day_df["VWAP"]) &
        (day_df["Close"] > day_df["Open"]) &
        (day_df["Volume"] > day_df["vol_sma_5"] * vol_mult)
    )

    trades = []
    short_hits = np.flatnonzero(short_mask.to_numpy(dtype=bool))
    if len(short_hits) > 0:
        short_idx = int(short_hits[0])
        short_trigger = float(day_df.iloc[short_idx]["Close"])
        short_stop = float(day_df.iloc[short_idx]["High"]) * 1.001
        short_trade = simulate_trade(
            day_df,
            short_idx,
            "short",
            short_stop,
            risk_target(short_trigger, short_stop, "short", target_mult),
            "vwap_reclaim_rejection",
            parameters,
            "vwap_rejection_short",
        )
        if short_trade:
            trades.append(short_trade)

    long_hits = np.flatnonzero(long_mask.to_numpy(dtype=bool))
    if len(long_hits) > 0:
        long_idx = int(long_hits[0])
        long_trigger = float(day_df.iloc[long_idx]["Close"])
        long_stop = float(day_df.iloc[long_idx]["Low"]) * 0.999
        long_trade = simulate_trade(
            day_df,
            long_idx,
            "long",
            long_stop,
            risk_target(long_trigger, long_stop, "long", target_mult),
            "vwap_reclaim_rejection",
            parameters,
            "vwap_rejection_long",
        )
        if long_trade:
            trades.append(long_trade)

    return trades


STRATEGIES: dict[str, list[StrategyVariant]] = {
    "orb_breakout": [
        StrategyVariant("orb_breakout", {"breakout_buffer": 0.001, "target_multiplier": 1.0, "vol_mult": 1.2}),
        StrategyVariant("orb_breakout", {"breakout_buffer": 0.003, "target_multiplier": 1.5, "vol_mult": 1.5}),
        StrategyVariant("orb_breakout", {"breakout_buffer": 0.005, "target_multiplier": 2.0, "vol_mult": 1.5}),
    ],
    "or_trap": [
        StrategyVariant("or_trap", {"breakout_buffer": 0.001, "target_multiplier": 0.5}),
        StrategyVariant("or_trap", {"breakout_buffer": 0.003, "target_multiplier": 1.0}),
        StrategyVariant("or_trap", {"breakout_buffer": 0.005, "target_multiplier": 1.0}),
    ],
    "pdh_pdl_trap": [
        StrategyVariant("pdh_pdl_trap", {"target_multiplier": 0.5, "displacement": 0.0075}),
        StrategyVariant("pdh_pdl_trap", {"target_multiplier": 1.0, "displacement": 0.0075}),
    ],
    "gap_reversal": [
        StrategyVariant("gap_reversal", {"gap_pct": 0.003, "target_multiplier": 0.5}),
        StrategyVariant("gap_reversal", {"gap_pct": 0.005, "target_multiplier": 1.0}),
        StrategyVariant("gap_reversal", {"gap_pct": 0.01, "target_multiplier": 1.0}),
    ],
    "gap_and_go": [
        StrategyVariant("gap_and_go", {"gap_pct": 0.003, "target_multiplier": 1.0, "vol_mult": 1.2}),
        StrategyVariant("gap_and_go", {"gap_pct": 0.005, "target_multiplier": 1.5, "vol_mult": 1.3}),
        StrategyVariant("gap_and_go", {"gap_pct": 0.01, "target_multiplier": 1.5, "vol_mult": 1.5}),
    ],
    "vwap_reclaim_rejection": [
        StrategyVariant("vwap_reclaim_rejection", {"displacement": 0.002, "target_multiplier": 1.0, "vol_mult": 1.2}),
        StrategyVariant("vwap_reclaim_rejection", {"displacement": 0.003, "target_multiplier": 1.0, "vol_mult": 1.2}),
        StrategyVariant("vwap_reclaim_rejection", {"displacement": 0.005, "target_multiplier": 1.0, "vol_mult": 1.5}),
    ],
}


STRATEGY_DISPATCH = {
    "orb_breakout": strategy_orb_breakout,
    "or_trap": strategy_or_trap,
    "pdh_pdl_trap": strategy_pdh_pdl_trap,
    "gap_reversal": strategy_gap_reversal,
    "gap_and_go": strategy_gap_and_go,
    "vwap_reclaim_rejection": strategy_vwap_reclaim_rejection,
}


def summarise_trades(trades: list[dict[str, Any]]) -> dict[str, Any]:
    if not trades:
        return {
            "trade_count": 0,
            "wins": 0,
            "losses": 0,
            "flat": 0,
            "gross_pnl": 0.0,
            "net_pnl": 0.0,
            "charges": 0.0,
            "win_rate": 0.0,
            "profit_factor": None,
            "expectancy": 0.0,
            "average_r": None,
            "max_drawdown": 0.0,
            "best_trade": None,
            "worst_trade": None,
        }

    df = pd.DataFrame(trades)
    gross_pnl = float(df["gross_pnl"].sum())
    net_pnl = float(df["net_pnl"].sum())
    charges = float((df["brokerage"] + df["statutory_charges"]).sum())
    wins = int((df["net_pnl"] > 0).sum())
    losses = int((df["net_pnl"] < 0).sum())
    flat = int((df["net_pnl"] == 0).sum())
    win_rate = wins / len(df) if len(df) else 0.0
    gross_wins = float(df.loc[df["net_pnl"] > 0, "net_pnl"].sum())
    gross_losses = abs(float(df.loc[df["net_pnl"] < 0, "net_pnl"].sum()))
    profit_factor = None if gross_losses == 0 else gross_wins / gross_losses
    expectancy = net_pnl / len(df)
    if "risk_amount" in df and (df["risk_amount"] > 0).any():
        valid = df["risk_amount"] > 0
        average_r = float((df.loc[valid, "net_pnl"] / df.loc[valid, "risk_amount"]).mean())
    else:
        average_r = None

    equity = df["net_pnl"].cumsum()
    peak = equity.cummax()
    max_drawdown = float((peak - equity).max())

    best_idx = df["net_pnl"].idxmax()
    worst_idx = df["net_pnl"].idxmin()
    best_trade = df.loc[best_idx, ["symbol", "side", "net_pnl", "exit_reason"]].to_dict()
    worst_trade = df.loc[worst_idx, ["symbol", "side", "net_pnl", "exit_reason"]].to_dict()

    return {
        "trade_count": int(len(df)),
        "wins": wins,
        "losses": losses,
        "flat": flat,
        "gross_pnl": round(gross_pnl, 4),
        "net_pnl": round(net_pnl, 4),
        "charges": round(charges, 4),
        "win_rate": round(win_rate, 4),
        "profit_factor": None if profit_factor is None else round(profit_factor, 4),
        "expectancy": round(expectancy, 4),
        "average_r": None if average_r is None else round(average_r, 4),
        "max_drawdown": round(max_drawdown, 4),
        "best_trade": best_trade,
        "worst_trade": worst_trade,
    }


def split_trades(trades: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    buckets = {"stress": [], "discovery": [], "validation": [], "holdout": []}
    for trade in trades:
        buckets[classify_split(pd.Timestamp(trade["entry_time"]))].append(trade)
    return buckets


def build_yearly_breakdown(trades: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for trade in trades:
        year = pd.Timestamp(trade["entry_time"]).year
        buckets.setdefault(str(year), []).append(trade)
    return {year: summarise_trades(items) for year, items in sorted(buckets.items())}


def recommendation_for(summary_by_split: dict[str, dict[str, Any]]) -> tuple[str, str, float]:
    validation = summary_by_split.get("validation", summarise_trades([]))
    holdout = summary_by_split.get("holdout", summarise_trades([]))
    discovery = summary_by_split.get("discovery", summarise_trades([]))

    validation_pf = validation.get("profit_factor") or 0.0
    holdout_pf = holdout.get("profit_factor") or 0.0
    validation_net = validation.get("net_pnl") or 0.0
    validation_count = validation.get("trade_count") or 0
    holdout_net = holdout.get("net_pnl") or 0.0
    discovery_pf = discovery.get("profit_factor") or 0.0

    score = (
        validation_net
        + 0.5 * holdout_net
        + 1000.0 * (validation_pf - 1.0)
        + 500.0 * (holdout_pf - 1.0)
        + 200.0 * (discovery_pf - 1.0)
    )

    if validation_count >= 40 and validation_net > 0 and validation_pf >= 1.15 and holdout_pf >= 1.0:
        return "paper_live_small", "Validation is positive and holdout is not breaking down.", score
    if validation_count >= 25 and validation_net > 0 and validation_pf >= 1.05:
        return "shadow", "Validation is positive but not yet strong enough for live sizing.", score
    return "disabled", "Did not clear the validation thresholds.", score


def run_research(
    data_dir: Path,
    universe: str,
    symbols: list[str] | None,
    min_start: str,
    output_dir: Path,
    smoke: bool = False,
) -> Path:
    min_start_ts = pd.Timestamp(min_start, tz=IST)
    paths = build_universe(data_dir, universe, symbols)
    if smoke:
        paths = paths[:3]
    if not paths:
        raise SystemExit(f"No CSV files found in {data_dir}")

    coverage: list[Coverage] = []
    strategy_trades: dict[tuple[str, str], list[dict[str, Any]]] = {}

    for path in paths:
        frame, info = load_symbol_frame(path)
        if frame is None or info is None:
            continue
        coverage.append(info)

        enriched = enrich_intraday_frame(frame)
        for day, day_df in enriched.groupby(enriched.index.normalize()):
            if pd.Timestamp(day) < min_start_ts:
                continue

            for strategy_name, variants in STRATEGIES.items():
                runner = STRATEGY_DISPATCH[strategy_name]
                for variant in variants:
                    trades = runner(day_df, variant.parameters)
                    if not trades:
                        continue
                    key = (strategy_name, json.dumps(variant.parameters, sort_keys=True))
                    strategy_trades.setdefault(key, []).extend(trades)

    strategy_results = []
    all_trades: list[dict[str, Any]] = []

    for (strategy_name, params_json), trades in sorted(strategy_trades.items(), key=lambda item: item[0][0]):
        params = json.loads(params_json)
        split_sets = split_trades(trades)
        split_summaries = {split: summarise_trades(items) for split, items in split_sets.items()}
        recommendation, reason, score = recommendation_for(split_summaries)
        yearly = build_yearly_breakdown(trades)
        strategy_results.append(
            {
                "strategy": strategy_name,
                "parameters": params,
                "selection_score": round(score, 4),
                "recommendation": recommendation,
                "recommendation_reason": reason,
                "splits": split_summaries,
                "year_by_year": yearly,
                "trade_count": len(trades),
            }
        )
        all_trades.extend(trades)

    strategy_results.sort(
        key=lambda row: (
            row["splits"]["validation"]["net_pnl"],
            row["splits"]["validation"]["profit_factor"] or 0.0,
            row["splits"]["holdout"]["profit_factor"] or 0.0,
            row["splits"]["validation"]["trade_count"],
        ),
        reverse=True,
    )

    report = {
        "configuration": {
            "universe": universe,
            "timeframe": "5m",
            "data_dir": str(data_dir),
            "smoke": smoke,
            "min_start": min_start_ts.isoformat(),
            "cost_model": {
                "base_risk_amount": BASE_RISK_AMOUNT,
                "risk_multiplier": DEFAULT_RISK_MULTIPLIER,
                "entry_slippage_pct": ENTRY_SLIPPAGE_PCT,
                "target_exit_slippage_pct": TARGET_EXIT_SLIPPAGE_PCT,
                "stop_exit_slippage_pct": STOP_EXIT_SLIPPAGE_PCT,
                "eod_exit_slippage_pct": EOD_EXIT_SLIPPAGE_PCT,
                "brokerage_per_trade": BROKERAGE_PER_TRADE,
                "statutory_fee_pct": STATUTORY_FEE_PCT,
            },
            "splits": {
                "stress": {"start": STRESS_START.isoformat(), "end": TRAIN_START.isoformat()},
                "discovery": {"start": TRAIN_START.isoformat(), "end": VALIDATION_START.isoformat()},
                "validation": {"start": VALIDATION_START.isoformat(), "end": HOLDOUT_START.isoformat()},
                "holdout": {"start": HOLDOUT_START.isoformat(), "end": None},
            },
            "strategies": {name: [variant.parameters for variant in variants] for name, variants in STRATEGIES.items()},
            "coverage_warning": "Current universe is survivorship-biased because it uses present-day symbols with uneven start dates.",
            "symbols_requested": symbols or [],
        },
        "coverage": [asdict(item) for item in sorted(coverage, key=lambda x: x.symbol)],
        "strategy_results": strategy_results,
        "trades": all_trades,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    out_path = output_dir / f"pattern-lab-5m-{timestamp}.json"
    out_path.write_text(json.dumps(report, indent=2, sort_keys=True))

    print("\n--- Strategy Ranking ---")
    for row in strategy_results[:10]:
        validation = row["splits"]["validation"]
        holdout = row["splits"]["holdout"]
        print(
            f"{row['strategy']} {row['parameters']} | "
            f"validation net={validation['net_pnl']:.2f} pf={validation['profit_factor']} "
            f"holdout net={holdout['net_pnl']:.2f} pf={holdout['profit_factor']} "
            f"=> {row['recommendation']}"
        )

    print(f"\nReport written to {out_path}")
    return out_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Post-2020 strategy research runner")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR), help="Directory with raw 5m CSVs")
    parser.add_argument("--output-dir", default=str(DEFAULT_REPORT_DIR), help="Where to write the JSON report")
    parser.add_argument("--universe", default="nifty50", choices=["nifty50", "all"], help="Symbol universe")
    parser.add_argument("--symbols", default="", help="Optional comma-separated symbol allowlist")
    parser.add_argument("--min-start", default="2020-01-01", help="Ignore bars before this date")
    parser.add_argument("--smoke", action="store_true", help="Run a tiny subset for verification")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    run_research(
        data_dir=Path(args.data_dir),
        universe=args.universe,
        symbols=symbols or None,
        min_start=args.min_start,
        output_dir=Path(args.output_dir),
        smoke=args.smoke,
    )


if __name__ == "__main__":
    main()
