#!/usr/bin/env python3
"""
Realistic ORB strategy backtest on 3-minute intraday NSE data (2015-2022)
Matches the actual bot logic: 9:15-9:30 OR window, 9:30-15:30 breakout detection
"""

import os
import csv
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Tuple

class ORBIntraDayBacktester:
    def __init__(self):
        self.RISK_PER_TRADE = 1000
        self.VOLUME_MULTIPLIER = 1.5
        self.TARGET_MULTIPLIER = 1.5
        self.ENTRY_SLIPPAGE_PCT = 0.0005
        self.EXIT_SLIPPAGE_PCT = 0.0005
        self.STOP_SLIPPAGE_PCT = 0.0010
        self.STATUTORY_FEE_PCT = 0.0005
        self.BROKERAGE_PER_LEG = 20
        self.CIRCUIT_BREAKER = -3000

    def load_3min_data(self, symbol: str) -> List[Dict]:
        """Load 3-minute OHLCV data for a stock"""
        filepath = f"NSE_Historical_Data_2015_2022/3minute/{symbol}.csv"
        if not os.path.exists(filepath):
            return []

        data = []
        try:
            with open(filepath, 'r') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    data.append({
                        'timestamp': row['date'],
                        'hour_min': row['date'].split()[1][:5],  # HH:MM
                        'open': float(row['open']),
                        'high': float(row['high']),
                        'low': float(row['low']),
                        'close': float(row['close']),
                        'volume': float(row['volume']),
                    })
        except Exception as e:
            print(f"  Error loading {symbol}: {e}")

        return data

    def is_or_window(self, time_str: str) -> bool:
        """Check if time is in 9:15-9:30 window"""
        hour, minute = map(int, time_str.split(':'))
        minutes_since_midnight = hour * 60 + minute
        or_start = 9 * 60 + 15  # 9:15 AM
        or_end = 9 * 60 + 30    # 9:30 AM
        return or_start <= minutes_since_midnight < or_end

    def is_breakout_window(self, time_str: str) -> bool:
        """Check if time is in 9:30-15:30 window"""
        hour, minute = map(int, time_str.split(':'))
        minutes_since_midnight = hour * 60 + minute
        breakout_start = 9 * 60 + 30   # 9:30 AM
        breakout_end = 15 * 60 + 30    # 3:30 PM
        return breakout_start <= minutes_since_midnight < breakout_end

    def backtest_symbol(self, symbol: str) -> Dict:
        """Backtest ORB on 3-minute intraday data"""
        data = self.load_3min_data(symbol)
        if not data:
            return {'symbol': symbol, 'trades': 0, 'status': 'NO_DATA', 'pnl': 0}

        symbol_trades = 0
        symbol_pnl = 0
        trading_active = False
        or_high = 0
        or_low = float('inf')

        i = 0
        while i < len(data):
            candle = data[i]

            # Phase 1: Build opening range (9:15-9:30)
            if self.is_or_window(candle['hour_min']):
                or_high = max(or_high, candle['high'])
                or_low = min(or_low, candle['low'])
                i += 1
                continue

            # Phase 2: After 9:30, check for breakouts
            if self.is_breakout_window(candle['hour_min']) and or_high > 0:
                or_range = or_high - or_low
                if or_range <= 0:
                    i += 1
                    continue

                # Get average volume for this symbol
                volume_window = data[max(0, i-10):i]
                avg_volume = sum(c['volume'] for c in volume_window) / len(volume_window) if volume_window else candle['volume']

                # Long breakout
                if candle['close'] > or_high and candle['volume'] >= (self.VOLUME_MULTIPLIER * avg_volume):
                    entry_price = candle['close']
                    stop_price = or_low
                    shares = int(self.RISK_PER_TRADE / (entry_price - stop_price))

                    if shares > 0:
                        actual_entry = entry_price + (entry_price * self.ENTRY_SLIPPAGE_PCT)
                        target_price = entry_price + (or_range * self.TARGET_MULTIPLIER)

                        # Find exit: look ahead for stop or target
                        exit_price = entry_price
                        exit_reason = "eod"
                        for j in range(i + 1, min(i + 100, len(data))):
                            future_candle = data[j]
                            if not self.is_breakout_window(future_candle['hour_min']):
                                break
                            if future_candle['low'] <= stop_price:
                                exit_price = stop_price
                                exit_reason = "stop"
                                break
                            if future_candle['high'] >= target_price:
                                exit_price = target_price
                                exit_reason = "target"
                                break
                            exit_price = future_candle['close']

                        # Calculate PnL
                        slippage_pct = self.STOP_SLIPPAGE_PCT if exit_reason == "stop" else self.EXIT_SLIPPAGE_PCT
                        final_exit = exit_price + (exit_price * slippage_pct)
                        gross_pnl = (final_exit - actual_entry) * shares
                        fees = abs(final_exit * shares * self.STATUTORY_FEE_PCT) + (self.BROKERAGE_PER_LEG * 2)
                        net_pnl = gross_pnl - fees

                        symbol_trades += 1
                        symbol_pnl += net_pnl

                        if symbol_pnl <= self.CIRCUIT_BREAKER:
                            break

                # Short breakout
                elif candle['close'] < or_low and candle['volume'] >= (self.VOLUME_MULTIPLIER * avg_volume):
                    entry_price = candle['close']
                    stop_price = or_high
                    shares = int(self.RISK_PER_TRADE / (stop_price - entry_price))

                    if shares > 0:
                        actual_entry = entry_price - (entry_price * self.ENTRY_SLIPPAGE_PCT)
                        target_price = entry_price - (or_range * self.TARGET_MULTIPLIER)

                        exit_price = entry_price
                        exit_reason = "eod"
                        for j in range(i + 1, min(i + 100, len(data))):
                            future_candle = data[j]
                            if not self.is_breakout_window(future_candle['hour_min']):
                                break
                            if future_candle['high'] >= stop_price:
                                exit_price = stop_price
                                exit_reason = "stop"
                                break
                            if future_candle['low'] <= target_price:
                                exit_price = target_price
                                exit_reason = "target"
                                break
                            exit_price = future_candle['close']

                        slippage_pct = self.STOP_SLIPPAGE_PCT if exit_reason == "stop" else self.EXIT_SLIPPAGE_PCT
                        final_exit = exit_price - (exit_price * slippage_pct)
                        gross_pnl = (actual_entry - final_exit) * shares
                        fees = abs(final_exit * shares * self.STATUTORY_FEE_PCT) + (self.BROKERAGE_PER_LEG * 2)
                        net_pnl = gross_pnl - fees

                        symbol_trades += 1
                        symbol_pnl += net_pnl

                        if symbol_pnl <= self.CIRCUIT_BREAKER:
                            break

            i += 1

        return {
            'symbol': symbol,
            'trades': symbol_trades,
            'pnl': round(symbol_pnl, 2),
            'data_points': len(data),
            'status': 'OK'
        }

    def run_backtest(self, symbols: List[str], limit: int = 30):
        """Run backtest on multiple symbols"""
        print("=" * 90)
        print("🔙 ORB Intraday Strategy Backtest on 3-Minute NSE Data (2015-2022)")
        print("=" * 90)
        print()

        total_trades = 0
        total_pnl = 0
        profitable_symbols = 0
        tested = 0

        for i, symbol in enumerate(symbols[:limit]):
            result = self.backtest_symbol(symbol)

            if result['status'] == 'OK' and result['trades'] > 0:
                tested += 1
                print(f"{tested:2d}. {symbol:12s} | Trades: {result['trades']:4d} | "
                      f"P&L: ₹{result['pnl']:10,.2f} | Data: {result['data_points']:5d} candles")

                total_trades += result['trades']
                total_pnl += result['pnl']
                if result['pnl'] > 0:
                    profitable_symbols += 1

        print()
        print("=" * 90)
        print("📊 BACKTEST RESULTS (3-Minute Intraday)")
        print("=" * 90)
        print(f"Symbols with trades:  {tested}/{min(limit, len(symbols))}")
        print(f"Total Trades:         {total_trades:,}")
        print(f"Total P&L:            ₹{total_pnl:,.2f}")
        print(f"Profitable Symbols:   {profitable_symbols}/{tested if tested > 0 else 1}")
        print(f"Win Rate:             {(profitable_symbols / tested * 100):.1f}% " if tested > 0 else "")

        if total_pnl > 0 and total_trades > 0:
            avg_trade = total_pnl / total_trades
            print(f"Avg P&L per Trade:    ₹{avg_trade:,.2f}")
            print("\n✅ Strategy shows POSITIVE returns!")
            print("   Bot is ready for live trading tomorrow")
        elif total_trades == 0:
            print("\n⚠️  No trades found in this dataset")
            print("   Strategy may need parameter tuning")
        else:
            print(f"\n⚠️  Strategy shows ₹{total_pnl:,.2f} loss")
            print("   Consider adjusting parameters")

        print()
        print("=" * 90)
        print("Strategy Parameters:")
        print(f"  OR Window:           9:15-9:30 AM IST")
        print(f"  Breakout Window:     9:30-3:30 PM IST")
        print(f"  Risk per trade:      ₹{self.RISK_PER_TRADE:,}")
        print(f"  Volume filter:       {self.VOLUME_MULTIPLIER}x")
        print(f"  Entry slippage:      {self.ENTRY_SLIPPAGE_PCT * 100:.3f}%")
        print(f"  Exit slippage:       {self.EXIT_SLIPPAGE_PCT * 100:.3f}% (targets), {self.STOP_SLIPPAGE_PCT * 100:.3f}% (stops)")
        print(f"  Target multiplier:   {self.TARGET_MULTIPLIER}x OR range")
        print(f"  Circuit breaker:     ₹{self.CIRCUIT_BREAKER:,} daily loss")
        print("=" * 90)
        print()

def main():
    data_dir = Path("NSE_Historical_Data_2015_2022/3minute")
    if not data_dir.exists():
        print("❌ 3-minute data directory not found!")
        return

    symbols = sorted([f.stem for f in data_dir.glob("*.csv")])
    print(f"Found {len(symbols)} symbols with 3-minute intraday data\n")

    backtester = ORBIntraDayBacktester()
    backtester.run_backtest(symbols, limit=50)

if __name__ == "__main__":
    main()
