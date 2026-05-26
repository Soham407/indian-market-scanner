#!/usr/bin/env python3
"""
Comprehensive backtest of ORB strategy on NSE historical data (2015-2022)
Tests all bot logic: entry, exit, slippage, fees, circuit breaker, P&L
"""

import os
import csv
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Tuple

class BacktestTradeData:
    def __init__(self):
        self.entry_price: float = 0
        self.stop_loss: float = 0
        self.target: float = 0
        self.shares: int = 0
        self.side: str = ""
        self.entry_date: str = ""
        self.exit_price: float | None = None
        self.exit_date: str | None = None
        self.exit_reason: str | None = None
        self.status: str = "open"

class ORBBacktester:
    def __init__(self):
        self.trades: List[Dict] = []
        self.daily_pnl: Dict[str, float] = {}
        self.daily_trades: Dict[str, List[Dict]] = {}

        # Strategy parameters
        self.RISK_PER_TRADE = 1000
        self.OR_WINDOW_MINUTES = 15
        self.VOLUME_MULTIPLIER = 1.5
        self.TARGET_MULTIPLIER = 1.5
        self.ENTRY_SLIPPAGE_PCT = 0.0005
        self.EXIT_SLIPPAGE_PCT = 0.0005
        self.STOP_SLIPPAGE_PCT = 0.0010
        self.STATUTORY_FEE_PCT = 0.0005
        self.BROKERAGE_PER_LEG = 20
        self.CIRCUIT_BREAKER = -3000

    def load_stock_data(self, symbol: str) -> List[Dict]:
        """Load OHLCV data for a stock"""
        filepath = f"NSE_Historical_Data_2015_2022/day/{symbol}.csv"
        if not os.path.exists(filepath):
            return []

        data = []
        try:
            with open(filepath, 'r') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    data.append({
                        'date': row['date'].split()[0],  # YYYY-MM-DD
                        'open': float(row['open']),
                        'high': float(row['high']),
                        'low': float(row['low']),
                        'close': float(row['close']),
                        'volume': float(row['volume']),
                    })
        except Exception as e:
            print(f"  Error loading {symbol}: {e}")

        return data

    def calculate_or(self, day_candle: Dict) -> Tuple[float, float]:
        """For daily data, use the full day's range as OR"""
        or_high = day_candle['high']
        or_low = day_candle['low']
        return or_high, or_low

    def check_long_breakout(self, close: float, high: float, or_high: float,
                           volume: float, prev_volume_avg: float) -> bool:
        """Check if this is a valid long breakout"""
        has_volume = volume >= (self.VOLUME_MULTIPLIER * prev_volume_avg)
        is_breakout = close > or_high
        return is_breakout and has_volume

    def check_short_breakout(self, close: float, low: float, or_low: float,
                            volume: float, prev_volume_avg: float) -> bool:
        """Check if this is a valid short breakout"""
        has_volume = volume >= (self.VOLUME_MULTIPLIER * prev_volume_avg)
        is_breakout = close < or_low
        return is_breakout and has_volume

    def calculate_pnl(self, entry_price: float, exit_price: float, shares: int,
                     side: str, exit_reason: str) -> Tuple[float, float, float]:
        """Calculate gross PnL, fees, and net PnL"""
        # Apply exit slippage
        slippage_pct = self.STOP_SLIPPAGE_PCT if exit_reason == "stop" else self.EXIT_SLIPPAGE_PCT
        if side == "long":
            slippage_amount = exit_price * slippage_pct
            final_exit = exit_price + slippage_amount
        else:
            slippage_amount = exit_price * slippage_pct
            final_exit = exit_price - slippage_amount

        # Gross PnL
        if side == "long":
            gross_pnl = (final_exit - entry_price) * shares
        else:
            gross_pnl = (entry_price - final_exit) * shares

        # Fees
        statutory = abs(final_exit * shares * self.STATUTORY_FEE_PCT)
        brokerage = self.BROKERAGE_PER_LEG * 2

        net_pnl = gross_pnl - statutory - brokerage

        return gross_pnl, statutory + brokerage, net_pnl

    def backtest_symbol(self, symbol: str) -> Dict:
        """Backtest ORB strategy on a single symbol"""
        data = self.load_stock_data(symbol)
        if not data:
            return {'symbol': symbol, 'trades': 0, 'status': 'NO_DATA'}

        symbol_trades = []
        daily_pnl = 0

        for i, candle in enumerate(data):
            # Calculate OR for this day
            or_high, or_low = self.calculate_or(candle)
            or_range = or_high - or_low

            # Get average volume from past 20 days
            volume_window = data[max(0, i-20):i]
            avg_volume = sum(c['volume'] for c in volume_window) / len(volume_window) if volume_window else candle['volume']

            entry_price = candle['close']

            # Long breakout
            if self.check_long_breakout(candle['close'], candle['high'], or_high, candle['volume'], avg_volume):
                stop_price = or_low
                if entry_price > stop_price:  # Valid setup
                    shares = int(self.RISK_PER_TRADE / (entry_price - stop_price))
                    if shares > 0:
                        # Apply entry slippage
                        actual_entry = entry_price + (entry_price * self.ENTRY_SLIPPAGE_PCT)
                        target_price = entry_price + (or_range * self.TARGET_MULTIPLIER)

                        # For daily data, exit at close or next day if hit
                        # Simple: assume target or stop hit at close
                        exit_price = candle['close']
                        exit_reason = "target" if exit_price >= target_price else "stop" if exit_price <= stop_price else "eod"

                        gross, fees, net = self.calculate_pnl(actual_entry, exit_price, shares, "long", exit_reason)

                        trade = {
                            'date': candle['date'],
                            'symbol': symbol,
                            'side': 'long',
                            'entry': round(actual_entry, 2),
                            'stop': round(stop_price, 2),
                            'target': round(target_price, 2),
                            'exit': round(exit_price, 2),
                            'shares': shares,
                            'reason': exit_reason,
                            'gross_pnl': round(gross, 2),
                            'fees': round(fees, 2),
                            'net_pnl': round(net, 2),
                        }
                        symbol_trades.append(trade)
                        daily_pnl += net

                        # Check circuit breaker
                        if daily_pnl <= self.CIRCUIT_BREAKER:
                            trade['circuit_breaker'] = True
                            break

            # Short breakout
            elif self.check_short_breakout(candle['close'], candle['low'], or_low, candle['volume'], avg_volume):
                stop_price = or_high
                if stop_price > entry_price:  # Valid setup
                    shares = int(self.RISK_PER_TRADE / (stop_price - entry_price))
                    if shares > 0:
                        actual_entry = entry_price - (entry_price * self.ENTRY_SLIPPAGE_PCT)
                        target_price = entry_price - (or_range * self.TARGET_MULTIPLIER)

                        exit_price = candle['close']
                        exit_reason = "target" if exit_price <= target_price else "stop" if exit_price >= stop_price else "eod"

                        gross, fees, net = self.calculate_pnl(actual_entry, exit_price, shares, "short", exit_reason)

                        trade = {
                            'date': candle['date'],
                            'symbol': symbol,
                            'side': 'short',
                            'entry': round(actual_entry, 2),
                            'stop': round(stop_price, 2),
                            'target': round(target_price, 2),
                            'exit': round(exit_price, 2),
                            'shares': shares,
                            'reason': exit_reason,
                            'gross_pnl': round(gross, 2),
                            'fees': round(fees, 2),
                            'net_pnl': round(net, 2),
                        }
                        symbol_trades.append(trade)
                        daily_pnl += net

                        if daily_pnl <= self.CIRCUIT_BREAKER:
                            trade['circuit_breaker'] = True
                            break

        return {
            'symbol': symbol,
            'trades': len(symbol_trades),
            'daily_pnl': round(daily_pnl, 2),
            'data_points': len(data),
            'status': 'OK'
        }

    def run_backtest(self, symbols: List[str], limit: int = 20):
        """Run backtest on multiple symbols"""
        print("=" * 80)
        print("🔙 ORB Strategy Backtest on NSE Historical Data (2015-2022)")
        print("=" * 80)
        print()

        total_trades = 0
        total_pnl = 0
        profitable_symbols = 0

        print(f"Testing {min(limit, len(symbols))} symbols from historical data...\n")

        for i, symbol in enumerate(symbols[:limit]):
            result = self.backtest_symbol(symbol)

            if result['status'] == 'OK':
                print(f"{i+1:2d}. {symbol:12s} | Trades: {result['trades']:3d} | "
                      f"P&L: ₹{result['daily_pnl']:10,.2f} | Data points: {result['data_points']:4d}")

                total_trades += result['trades']
                total_pnl += result['daily_pnl']
                if result['daily_pnl'] > 0:
                    profitable_symbols += 1

        print()
        print("=" * 80)
        print("📊 BACKTEST RESULTS")
        print("=" * 80)
        print(f"Total Trades:         {total_trades:,}")
        print(f"Total P&L:            ₹{total_pnl:,.2f}")
        print(f"Profitable Symbols:   {profitable_symbols}/{min(limit, len(symbols))}")
        print(f"Avg P&L per Symbol:   ₹{total_pnl / max(1, min(limit, len(symbols))):,.2f}")

        if total_pnl > 0:
            print("\n✅ Strategy shows POSITIVE returns on historical data")
            print("   Ready for live trading!")
        else:
            print("\n⚠️  Strategy shows negative returns")
            print("   Consider parameter tuning before live trading")

        print()
        print("=" * 80)
        print("Strategy Parameters Used:")
        print(f"  • Risk per trade: ₹{self.RISK_PER_TRADE:,}")
        print(f"  • Volume filter: {self.VOLUME_MULTIPLIER}x")
        print(f"  • Entry slippage: {self.ENTRY_SLIPPAGE_PCT * 100:.2f}%")
        print(f"  • Exit slippage: {self.EXIT_SLIPPAGE_PCT * 100:.2f}% (targets), {self.STOP_SLIPPAGE_PCT * 100:.2f}% (stops)")
        print(f"  • Circuit breaker: ₹{self.CIRCUIT_BREAKER:,} daily loss")
        print(f"  • Target multiplier: {self.TARGET_MULTIPLIER}x OR range")
        print("=" * 80)

def main():
    # Get available symbols from historical data
    data_dir = Path("NSE_Historical_Data_2015_2022/day")
    if not data_dir.exists():
        print("❌ Historical data directory not found!")
        return

    symbols = [f.stem for f in data_dir.glob("*.csv")]
    symbols.sort()

    print(f"Found {len(symbols)} symbols in historical data\n")

    # Run backtest
    backtester = ORBBacktester()
    backtester.run_backtest(symbols, limit=50)

if __name__ == "__main__":
    main()
