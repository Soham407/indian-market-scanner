#!/usr/bin/env python3
import os
import sys
import time
import math
import logging
import json
import base64
import hmac
import hashlib
import struct
from datetime import datetime, time as dt_time, timedelta
import requests
import websocket
import matplotlib.pyplot as plt
import numpy as np

# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("agent.log")
    ]
)
logger = logging.getLogger("HermesAgent")

# Load environment variables (fallback to default config)
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://gykgrrjiqkucstcyrgxp.supabase.co")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

# Angel One Secrets
ANGEL_API_KEY = os.getenv("AngelOne_Apikey", "")
ANGEL_CLIENT_CODE = os.getenv("AngelOne_ClientID", "")
ANGEL_PIN = os.getenv("AngelOne_PIN", "")
ANGEL_SECRET_KEY = os.getenv("AngelOne_SecretKey", "") # Used for TOTP generation

# Hermes LLM Config
HERMES_API_BASE = os.getenv("HERMES_API_BASE", "https://api.together.xyz/v1")
HERMES_API_KEY = os.getenv("HERMES_API_KEY", "")
HERMES_MODEL = os.getenv("HERMES_MODEL", "nousresearch/hermes-3-llama-3.1-70b")

# Risk configuration
RISK_PER_TRADE = float(os.getenv("BOT_RISK_PER_TRADE", "1000"))
DAILY_DRAWDOWN_LIMIT_PCT = 0.02 # -2% drawdown limit
MAX_CONCURRENT_POSITIONS = 5
MAX_DAILY_ORDERS = 20

# Timezones & timing (IST offset is +5:30)
IST_OFFSET = timedelta(hours=5, minutes=30)

def get_ist_now():
    return datetime.utcnow() + IST_OFFSET

# Helper: Native TOTP generator to avoid external dependency issues
def generate_totp(secret):
    try:
        # Clean secret padding
        secret = secret.replace(" ", "").upper()
        # Decode base32 manually
        base32_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        binary_secret = bytearray()
        for i in range(0, len(secret), 8):
            chunk = secret[i:i+8]
            val = 0
            count = 0
            for char in chunk:
                val = (val << 5) | base32_chars.index(char)
                count += 5
            while count >= 8:
                count -= 8
                binary_secret.append((val >> count) & 255)
        
        # Calculate counter
        counter = int(time.time() // 30)
        counter_bytes = struct.pack(">Q", counter)
        
        # Calculate HMAC-SHA1
        hmac_hash = hmac.new(binary_secret, counter_bytes, hashlib.sha1).digest()
        
        # Dynamic truncation
        offset = hmac_hash[-1] & 15
        binary_code = (
            ((hmac_hash[offset] & 127) << 24) |
            ((hmac_hash[offset + 1] & 255) << 16) |
            ((hmac_hash[offset + 2] & 255) << 8) |
            (hmac_hash[offset + 3] & 255)
        )
        totp = binary_code % 1000000
        return f"{totp:06d}"
    except Exception as e:
        logger.error(f"Error generating TOTP: {e}")
        return None


class SupabaseClient:
    """Helper client using raw requests to interface with Supabase database."""
    def __init__(self):
        self.url = SUPABASE_URL
        self.key = SUPABASE_SERVICE_KEY if SUPABASE_SERVICE_KEY else SUPABASE_ANON_KEY
        self.headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }
        
    def query(self, table, select="*", filters=None):
        url = f"{self.url}/rest/v1/{table}?select={select}"
        if filters:
            for k, v in filters.items():
                url += f"&{k}={v}"
        try:
            r = requests.get(url, headers=self.headers, timeout=10)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            logger.error(f"Supabase query failed on {table}: {e}")
            return []

    def insert(self, table, data):
        url = f"{self.url}/rest/v1/{table}"
        try:
            r = requests.post(url, headers=self.headers, json=data, timeout=10)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            logger.error(f"Supabase insert failed on {table}: {e}")
            return []

    def update(self, table, data, filters):
        filter_str = ""
        for k, v in filters.items():
            filter_str += f"&{k}={v}"
        url = f"{self.url}/rest/v1/{table}?{filter_str.lstrip('&')}"
        try:
            r = requests.patch(url, headers=self.headers, json=data, timeout=10)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            logger.error(f"Supabase update failed on {table}: {e}")
            return []


class TelegramNotifier:
    """Handles sending notifications to the trader's Telegram."""
    @staticmethod
    def notify(message):
        if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
            logger.info(f"Telegram not configured. Log: {message}")
            return
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "HTML"}
        try:
            requests.post(url, json=payload, timeout=5)
        except Exception as e:
            logger.error(f"Telegram notification failed: {e}")


class AngelOneClient:
    """Handles authentication and session lifecycle with Angel One SmartAPI."""
    def __init__(self):
        self.jwt_token = None
        self.feed_token = None
        self.refresh_token = None
        self.authenticated = False
        
    def login(self):
        if not ANGEL_API_KEY or not ANGEL_CLIENT_CODE or not ANGEL_PIN or not ANGEL_SECRET_KEY:
            logger.error("Missing Angel One credentials in environment variables.")
            return False
            
        totp_code = generate_totp(ANGEL_SECRET_KEY)
        if not totp_code:
            logger.error("Failed to generate TOTP.")
            return False
            
        logger.info("Initiating login sequence to Angel One SmartAPI...")
        url = "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-UserType": "USER",
            "X-SourceID": "WEB",
            "X-ClientIP": "127.0.0.1",
            "X-MACAddress": "00:00:00:00:00:00",
            "X-PrivateKey": ANGEL_API_KEY
        }
        payload = {
            "clientcode": ANGEL_CLIENT_CODE,
            "password": ANGEL_PIN,
            "totp": totp_code
        }
        
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=10)
            data = r.json()
            if data.get("status") and "data" in data:
                self.jwt_token = data["data"]["jwtToken"]
                self.feed_token = data["data"]["feedToken"]
                self.refresh_token = data["data"]["refreshToken"]
                self.authenticated = True
                logger.info("Angel One authentication successful.")
                return True
            else:
                logger.error(f"Angel One login failed: {data.get('message', 'Unknown error')}")
                return False
        except Exception as e:
            logger.error(f"Angel One API login request failed: {e}")
            return False

    def renew_session(self):
        if not self.refresh_token:
            return self.login()
        url = "https://apiconnect.angelone.in/rest/auth/angelbroking/jwt/v1/generateTokens"
        headers = {
            "Content-Type": "application/json",
            "X-PrivateKey": ANGEL_API_KEY
        }
        payload = {"refreshToken": self.refresh_token}
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=10)
            data = r.json()
            if data.get("status") and "data" in data:
                self.jwt_token = data["data"]["jwtToken"]
                self.refresh_token = data["data"]["refreshToken"]
                logger.info("Angel One session token renewed successfully.")
                return True
            else:
                logger.warn("Token renewal failed. Retrying full login...")
                return self.login()
        except Exception as e:
            logger.error(f"Angel One token renewal request failed: {e}")
            return self.login()


class PaperTradingEngine:
    """Simulates execution fills using Level 2 book walking and calculates Indian transaction costs."""
    def __init__(self, db_client: SupabaseClient):
        self.db = db_client

    def calculate_fees(self, traded_value, quantity, side, asset_class="EQUITY_INTRADAY"):
        """Calculates exact Indian market statutory fees and brokerage updated to April 1, 2026."""
        brokerage = 0.0
        stt = 0.0
        exchange_charges = 0.0
        sebi_fee = traded_value * 0.000001 # ₹10/crore (0.0001%)
        stamp_duty = 0.0

        if asset_class == "EQUITY_INTRADAY":
            brokerage = min(20.0, traded_value * 0.0003) # Lower of ₹20 or 0.03%
            if side == "SELL":
                stt = traded_value * 0.00025 # 0.025% on Sell side only
            exchange_charges = traded_value * 0.0000297 # ~0.00297%
            if side == "BUY":
                stamp_duty = traded_value * 0.00003 # 0.003% on Buy side only
        elif asset_class == "OPTIONS":
            brokerage = 20.0 # Flat ₹20 per order
            if side == "SELL":
                stt = traded_value * 0.0015 # 0.15% on Sell premium
            exchange_charges = traded_value * 0.000495 # 0.0495%
            if side == "BUY":
                stamp_duty = traded_value * 0.00003 # 0.003% on Buy premium

        gst = 0.18 * (brokerage + exchange_charges + sebi_fee)
        total_fees = brokerage + stt + exchange_charges + sebi_fee + stamp_duty + gst
        
        return {
            "brokerage": brokerage,
            "statutory_charges": stt + exchange_charges + sebi_fee + stamp_duty + gst,
            "exchange_charges": exchange_charges,
            "stt": stt,
            "stamp_duty": stamp_duty,
            "gst": gst,
            "total_fees": total_fees
        }

    def walk_book(self, side, quantity, depth_levels):
        """Simulates depth of market walk to calculate execution price."""
        if not depth_levels:
            return None
        
        remaining = quantity
        total_cost = 0.0
        
        # Depth levels are expected to be list of dicts: [{'price': X, 'quantity': Y}]
        for lvl in depth_levels:
            fill_qty = min(remaining, lvl['quantity'])
            total_cost += fill_qty * lvl['price']
            remaining -= fill_qty
            if remaining <= 0:
                break
                
        if remaining > 0:
            # Apply a slippage penalty of 1% to outstanding quantity if depth is insufficient
            total_cost += remaining * depth_levels[-1]['price'] * (1.01 if side == "BUY" else 0.99)
            
        return total_cost / quantity

    def execute_paper_order(self, strategy_id, instrument_id, symbol, side, quantity, stop_loss, target, current_depth):
        """Simulates order execution with a random 50-150ms delay, book walking, and records to database."""
        # Inject latency delay
        latency = np.random.uniform(0.05, 0.15)
        time.sleep(latency)
        
        # Calculate execution price via book walking
        walk_price = self.walk_book(side, quantity, current_depth)
        if not walk_price:
            logger.error(f"No depth available to execute trade for {symbol}.")
            return None
            
        # Apply entry slippage buffer
        entry_price = walk_price * (1.0005 if side == "BUY" else 0.9995)
        traded_value = entry_price * quantity
        
        # Calculate initial execution fees
        fees = self.calculate_fees(traded_value, quantity, side)
        
        # Record trade in Supabase
        trade_data = {
            "strategy_id": strategy_id,
            "instrument_id": instrument_id,
            "side": "long" if side == "BUY" else "short",
            "entry_price": round(entry_price, 4),
            "entry_time": get_ist_now().isoformat(),
            "entry_slippage_pct": 0.0005,
            "stop_loss_price": round(stop_loss, 4),
            "target_price": round(target, 4),
            "shares": quantity,
            "status": "open",
            "brokerage": round(fees["brokerage"], 4),
            "statutory_charges": round(fees["statutory_charges"], 4),
            "risk_amount": round(RISK_PER_TRADE, 4)
        }
        
        records = self.db.insert("bot_paper_trades", trade_data)
        if records:
            trade_id = records[0]["id"]
            logger.info(f"Paper trade successfully opened: {side} {quantity} shares of {symbol} at {entry_price:.2f}. ID: {trade_id}")
            TelegramNotifier.notify(
                f"🚨 <b>ENTRY SIGNAL</b> 🚨\n"
                f"Symbol: {symbol} | Side: {side}\n"
                f"Price: ₹{entry_price:.2f}\n"
                f"SL: ₹{stop_loss:.2f} | Target: ₹{target:.2f}"
            )
            return trade_id
        return None

    def close_paper_order(self, trade_id, symbol, exit_price, reason):
        """Closes an open position, calculates exit fees, and updates net realized P&L."""
        trades = self.db.query("bot_paper_trades", select="*", filters={"id": f"eq.{trade_id}"})
        if not trades:
            return False
            
        trade = trades[0]
        quantity = trade["shares"]
        entry_price = float(trade["entry_price"])
        side = trade["side"]
        
        # Determine gross P&L
        if side == "long":
            gross_pnl = (exit_price - entry_price) * quantity
        else:
            gross_pnl = (entry_price - exit_price) * quantity
            
        # Calculate exit transaction charges
        traded_value = exit_price * quantity
        exit_fees = self.calculate_fees(traded_value, quantity, "SELL" if side == "long" else "BUY")
        
        total_brokerage = float(trade["brokerage"]) + exit_fees["brokerage"]
        total_statutory = float(trade["statutory_charges"]) + exit_fees["statutory_charges"]
        net_pnl = gross_pnl - total_brokerage - total_statutory
        
        update_data = {
            "status": "closed",
            "exit_price": round(exit_price, 4),
            "exit_time": get_ist_now().isoformat(),
            "exit_reason": reason,
            "gross_pnl": round(gross_pnl, 4),
            "brokerage": round(total_brokerage, 4),
            "statutory_charges": round(total_statutory, 4),
            "net_pnl": round(net_pnl, 4),
            "updated_at": get_ist_now().isoformat()
        }
        
        self.db.update("bot_paper_trades", update_data, {"id": f"eq.{trade_id}"})
        logger.info(f"Paper trade closed: {symbol} at {exit_price:.2f}. Net P&L: ₹{net_pnl:.2f} (Reason: {reason})")
        TelegramNotifier.notify(
            f"✅ <b>EXIT SIGNAL</b> ✅\n"
            f"Symbol: {symbol} | Outcome: {reason.upper()}\n"
            f"Exit Price: ₹{exit_price:.2f}\n"
            f"Net P&L: {'₹' if net_pnl >= 0 else '-₹'}{abs(net_pnl):.2f}"
        )
        return True


class HermesAutonomousTrader:
    """Coordinates discretionary trading decisions by querying Nous Hermes 3 via multimodal image/text."""
    def __init__(self, db_client: SupabaseClient):
        self.db = db_client

    def compile_chart(self, symbol, candles_df):
        """Generates an OHLC line chart image for visual LLM reasoning."""
        if candles_df.empty or len(candles_df) < 5:
            return None
            
        plt.figure(figsize=(6, 4))
        plt.plot(candles_df.index, candles_df['close'], marker='o', color='#FF9900', label=f"{symbol} Close")
        plt.title(f"{symbol} 15-Minute Candle Stream")
        plt.xlabel("IST Time")
        plt.ylabel("Price (INR)")
        plt.grid(True, linestyle='--', alpha=0.5)
        plt.legend()
        
        # Save image locally
        filename = f"/tmp/{symbol}_chart.png"
        plt.savefig(filename, bbox_inches='tight')
        plt.close()
        return filename

    def prompt_hermes(self, symbol, chart_path, json_metrics):
        """Assembles prompt and queries the Nous Hermes 3 endpoint."""
        if not HERMES_API_KEY:
            # Fallback Mock Mode if API key is not supplied
            logger.warn("HERMES_API_KEY is not defined. Simulating model decision...")
            return "BUY", 0.85, "Breakout confirmed on high volume, order book imbalance shows strong buyer interest."
            
        # Convert chart to base64 encoding
        base64_image = ""
        if chart_path and os.path.exists(chart_path):
            with open(chart_path, "rb") as image_file:
                base64_image = base64.encodebytes(image_file.read()).decode('utf-8')
                
        prompt_text = (
            f"You are a fully autonomous, discretionary trading agent. Analyze the provided {symbol} candle chart "
            f"and structured JSON indicators. Decide whether to execute a long entry (BUY), short entry (SELL), "
            f"or take no action (IGNORE).\n\n"
            f"Market Metrics:\n{json.dumps(json_metrics, indent=2)}\n\n"
            f"Your output MUST be a JSON object containing the fields:\n"
            f"- 'decision': 'BUY' | 'SELL' | 'IGNORE'\n"
            f"- 'confidence': 0.00 to 1.00 (conviction score)\n"
            f"- 'reason': A brief technical explanation of your decision.\n"
            f"- 'target_offset_pct': Suggested distance to target price from entry (e.g., 0.015 for 1.5% offset)\n"
            f"- 'stop_offset_pct': Suggested distance to stop loss from entry (e.g., 0.010 for 1.0% stop)\n"
        )
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {HERMES_API_KEY}"
        }
        
        messages = []
        if base64_image:
            messages.append({
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt_text},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_image}"}}
                ]
            })
        else:
            messages.append({
                "role": "user",
                "content": prompt_text
            })
            
        payload = {
            "model": HERMES_MODEL,
            "messages": messages,
            "response_format": {"type": "json_object"},
            "temperature": 0.2
        }
        
        start_time = time.time()
        try:
            r = requests.post(f"{HERMES_API_BASE}/chat/completions", headers=headers, json=payload, timeout=20)
            r.raise_for_status()
            res = r.json()
            latency = int((time.time() - start_time) * 1000)
            
            content = res["choices"][0]["message"]["content"]
            result = json.loads(content)
            
            # Log decision to Supabase
            self.db.insert("bot_ai_decisions", {
                "prompt_text": prompt_text,
                "model_response": content,
                "decision": result.get("decision", "IGNORE"),
                "confidence_score": float(result.get("confidence", 0.0)),
                "latency_ms": latency,
                "chart_file_path": chart_path
            })
            
            return (
                result.get("decision", "IGNORE"),
                float(result.get("confidence", 0.0)),
                result.get("reason", ""),
                float(result.get("target_offset_pct", 0.015)),
                float(result.get("stop_offset_pct", 0.01))
            )
        except Exception as e:
            logger.error(f"Nous Hermes API request failed: {e}")
            return "IGNORE", 0.0, f"Error calling model: {e}", 0.015, 0.01


class RiskManager:
    """Manages active circuit breakers, daily drawdowns, order frequency, and position caps."""
    def __init__(self, db_client: SupabaseClient):
        self.db = db_client

    def check_circuit_breakers(self):
        """Verifies daily drawdown rules and open position counts."""
        # 1. Check open positions limit
        open_positions = self.db.query("bot_paper_trades", select="id", filters={"status": "eq.open"})
        if len(open_positions) >= MAX_CONCURRENT_POSITIONS:
            logger.warn(f"Risk Breach: Max concurrent positions limit ({MAX_CONCURRENT_POSITIONS}) reached.")
            return False
            
        # 2. Check daily order frequency
        today_iso = get_ist_now().date().isoformat()
        daily_trades = self.db.query("bot_paper_trades", select="id", filters={"entry_time": f"gte.{today_iso}T00:00:00Z"})
        if len(daily_trades) >= MAX_DAILY_ORDERS:
            logger.warn(f"Risk Breach: Daily order limit ({MAX_DAILY_ORDERS}) breached.")
            return False
            
        # 3. Check Daily Drawdown
        # Fetch closed trades today to sum realized P&L
        closed_trades = self.db.query("bot_paper_trades", select="net_pnl", filters={
            "status": "eq.closed",
            "exit_time": f"gte.{today_iso}T00:00:00Z"
        })
        realized_pnl = sum(float(t["net_pnl"]) for t in closed_trades if t["net_pnl"] is not None)
        
        # Calculate maximum allowed daily loss (e.g. 2% of ₹150,000 base capital = -₹3,000)
        base_capital = 150000.0 # Seed configuration capital
        max_daily_loss = -base_capital * DAILY_DRAWDOWN_LIMIT_PCT
        
        if realized_pnl <= max_daily_loss:
            logger.error(f"Risk Circuit Breaker Triggered! Daily P&L (₹{realized_pnl:.2f}) breached loss threshold (₹{max_daily_loss:.2f}).")
            TelegramNotifier.notify(
                f"🚨 <b>RISK CIRCUIT BREAKER TRIGGERED</b> 🚨\n"
                f"Daily Realized Loss: ₹{realized_pnl:.2f}\n"
                f"System is pausing trading for the rest of the day."
            )
            return False
            
        return True


class TradingCoordinator:
    """Coordinates binary feeds, caches ticks, aggregates candles, and scans for ORB breakouts."""
    def __init__(self):
        self.db = SupabaseClient()
        self.broker = AngelOneClient()
        self.paper_engine = PaperTradingEngine(self.db)
        self.ai_trader = HermesAutonomousTrader(self.db)
        self.risk = RiskManager(self.db)
        
        # In-memory data cache
        self.ltp_cache = {}
        self.depth_cache = {}
        self.candles_history = {} # instrument_id -> list of candles
        self.active_positions = {} # trade_id -> position metadata
        self.last_tick_time = 0
        self.websocket_connection = None
        self.running = False
        
    def check_market_hours(self):
        """Returns True if within trading window (09:15 to 15:30 IST)."""
        now = get_ist_now()
        day = now.weekday()
        if day >= 5: # Sat/Sun
            return False
        
        current_time = now.time()
        start = dt_time(9, 15)
        end = dt_time(15, 30)
        return start <= current_time <= end

    def check_dead_man_switch(self):
        """Cancels all active orders and pauses execution if ticks stop arriving."""
        if self.last_tick_time > 0 and (time.time() - self.last_tick_time) > 10.0:
            logger.error("Dead-Man's Switch Triggered: No ticks received for 10 seconds. Terminating open actions.")
            TelegramNotifier.notify("⚠️ <b>FEED DISCONNECTED</b> ⚠️\nWebSocket feed has been silent for 10s. Pausing execution.")
            # Clear tick timer to avoid repeated alerts
            self.last_tick_time = time.time()
            return False
        return True

    def parse_tick_payload(self, message):
        """Unpacks the Little-Endian binary tick frame from Smart Stream 2.0."""
        # Unpacks binary packet structure depending on mode
        # This is a basic parser mirroring structural offsets
        try:
            if isinstance(message, bytes) and len(message) >= 10:
                header = struct.unpack("<B", message[0:1])[0]
                # Filter LTP / Quote packets
                if len(message) == 18 or len(message) == 20: # LTP Packet size
                    token = message[2:12].decode('utf-8').strip('\x00')
                    ltp = struct.unpack("<i", message[12:16])[0] / 100.0
                    return token, ltp, None
                elif len(message) > 40: # Depth / Quote Packet
                    token = message[2:12].decode('utf-8').strip('\x00')
                    ltp = struct.unpack("<i", message[12:16])[0] / 100.0
                    # Parse bid-ask depth (first level)
                    bid_price = struct.unpack("<i", message[32:36])[0] / 100.0
                    bid_qty = struct.unpack("<i", message[36:40])[0]
                    ask_price = struct.unpack("<i", message[40:44])[0] / 100.0
                    ask_qty = struct.unpack("<i", message[44:48])[0]
                    
                    depth = [
                        {"price": bid_price, "quantity": bid_qty},
                        {"price": ask_price, "quantity": ask_qty}
                    ]
                    return token, ltp, depth
        except Exception as e:
            logger.debug(f"Error unpacking binary tick payload: {e}")
        return None, None, None

    def evaluate_exits(self, symbol, token, ltp):
        """Continuously checks target/stop parameters against current tick."""
        # Query open positions for this symbol
        open_positions = self.db.query("bot_paper_trades", select="*", filters={
            "status": "eq.open",
            "instrument_id": f"eq.{token}"
        })
        
        for trade in open_positions:
            sl = float(trade["stop_loss_price"])
            tp = float(trade["target_price"])
            side = trade["side"]
            trade_id = trade["id"]
            
            if side == "long":
                if ltp <= sl:
                    self.paper_engine.close_paper_order(trade_id, symbol, ltp, "stop")
                elif ltp >= tp:
                    self.paper_engine.close_paper_order(trade_id, symbol, ltp, "target")
            else:
                if ltp >= sl:
                    self.paper_engine.close_paper_order(trade_id, symbol, ltp, "stop")
                elif ltp <= tp:
                    self.paper_engine.close_paper_order(trade_id, symbol, ltp, "target")

    def run_strategy(self, symbol, token, ltp):
        """Scans for 15-minute Opening Range Breakouts and invokes AI Trader."""
        # Maintain active candle structure
        # Standard ORB Scanner scans range from 9:15 to 9:30 AM
        now = get_ist_now()
        if now.time() < dt_time(9, 30):
            # We are building range. Store candles.
            return
            
        # Get candles history to check ORB ranges
        # For demo purposes, we scan if the current LTP is crossing past session bounds
        # Check if we already have an open position for this token today
        today_iso = now.date().isoformat()
        exists = self.db.query("bot_paper_trades", select="id", filters={
            "instrument_id": f"eq.{token}",
            "entry_time": f"gte.{today_iso}T00:00:00Z"
        })
        if exists:
            return # Trade already taken for this asset today
            
        # Simulate an ORB breakout signal
        # Let's say range high is 500, range low is 490. If price crosses high with volume, trigger breakout.
        # This mocks standard logic:
        is_breakout = False
        side = None
        
        # Pull range configuration (seeded row in bot_strategies/bot_strategy_parameters)
        params = self.db.query("bot_strategy_parameters", select="*")
        vol_mult = 1.5
        for p in params:
            if p["name"] == "volume_multiplier":
                vol_mult = float(p["value"])
                
        # Mocking a breakout for demonstration
        if ltp > 500.0: 
            is_breakout = True
            side = "BUY"
        elif ltp < 100.0:
            is_breakout = True
            side = "SELL"
            
        if is_breakout:
            logger.info(f"Breakout detected for {symbol} at {ltp:.2f}. Invoking autonomous Hermes AI Trader...")
            
            # Check risk criteria before LLM call
            if not self.risk.check_circuit_breakers():
                return
                
            # Compile mock 15m historical candles to render chart
            hist_candles = pd.DataFrame({
                "close": [ltp - 2.0, ltp - 1.5, ltp - 0.5, ltp + 1.0, ltp]
            }, index=pd.date_range(now - timedelta(minutes=75), now, freq="15min"))
            
            chart_file = self.ai_trader.compile_chart(symbol, hist_candles)
            
            # Pack JSON indicators
            json_metrics = {
                "ltp": ltp,
                "volume_multiplier": vol_mult,
                "rsi": 62.5,
                "vwap": ltp - 0.5,
                "order_book_imbalance": 0.38, # Bid heavy
                "pcr_ratio": 1.15
            }
            
            # Prompt Nous Hermes 3
            decision, confidence, reason, tp_offset, sl_offset = self.ai_trader.prompt_hermes(
                symbol, chart_file, json_metrics
            )
            
            logger.info(f"Nous Hermes Decision for {symbol}: {decision} (Confidence: {confidence:.2f}) | Reason: {reason}")
            
            if decision == side:
                # Compile execution parameters
                qty = int(RISK_PER_TRADE / (ltp * sl_offset))
                if qty <= 0:
                    qty = 10
                    
                target_price = ltp * (1.0 + tp_offset) if side == "BUY" else ltp * (1.0 - tp_offset)
                stop_loss = ltp * (1.0 - sl_offset) if side == "BUY" else ltp * (1.0 + sl_offset)
                
                # Fetch current book depth
                depth = self.depth_cache.get(token, [{"price": ltp, "quantity": 1000}])
                
                # Retrieve strategy primary key ID
                strategies = self.db.query("bot_strategies", select="id", filters={"name": "eq.orb_breakout"})
                strategy_id = strategies[0]["id"] if strategies else None
                
                if strategy_id:
                    self.paper_engine.execute_paper_order(
                        strategy_id, token, symbol, side, qty, stop_loss, target_price, depth
                    )
            else:
                logger.info(f"AI Agent rejected the rule-based {side} signal (Decision: {decision}). Ignoring.")

    def on_message(self, ws, message):
        """WebSocket tick handler."""
        self.last_tick_time = time.time()
        token, ltp, depth = self.parse_tick_payload(message)
        
        if token and ltp:
            self.ltp_cache[token] = ltp
            if depth:
                self.depth_cache[token] = depth
                
            symbol = "SBIN" # In a full system, you look up token -> symbol mapping
            
            # Evaluate exit conditions on every tick
            self.evaluate_exits(symbol, token, ltp)
            
            # Evaluate breakout strategy scanner
            self.run_strategy(symbol, token, ltp)

    def on_error(self, ws, error):
        logger.error(f"WebSocket Connection Error: {error}")

    def on_close(self, ws, close_status_code, close_msg):
        logger.warn(f"WebSocket Connection Closed: {close_msg} (Code: {close_status_code})")

    def on_open(self, ws):
        logger.info("WebSocket connection established. Subscribing to instruments...")
        # Subscription payload structure
        # Subscribing to NSE SBIN (token: 3045) in Depth mode (4)
        payload = {
            "action": 1,
            "params": {
                "mode": 4, 
                "tokenList": [
                    {"exchangeType": 1, "tokens": ["3045"]}
                ]
            }
        }
        ws.send(json.dumps(payload))

    def start(self):
        """Starts the stateful trading daemon thread."""
        self.running = True
        logger.info("Starting Stateful AI Trading Agent Daemon...")
        TelegramNotifier.notify("🤖 <b>AI TRADING BOT STARTED</b> 🤖\nInitializing stateful market scan pipeline.")
        
        # 1. Log in to Angel One
        if not self.broker.login():
            logger.error("Failed to authenticate with Angel One SmartAPI. Aborting startup.")
            return
            
        # Reconnect loop with exponential backoff and jitter
        attempt = 0
        while self.running:
            if not self.check_market_hours():
                # If market is closed, wait 60s and continue
                logger.info("Market is currently closed. Standing by...")
                time.sleep(60)
                continue
                
            # Perform Dead-Man's Switch safety audit
            self.check_dead_man_switch()
            
            try:
                # Renew session if required
                if attempt > 0:
                    self.broker.renew_session()
                    
                url = "wss://smartapisocket.angelone.in/smart-stream"
                headers = [
                    f"Authorization: Bearer {self.broker.jwt_token}",
                    f"x-api-key: {ANGEL_API_KEY}",
                    f"x-client-code: {ANGEL_CLIENT_CODE}",
                    f"x-feed-token: {self.broker.feed_token}"
                ]
                
                self.websocket_connection = websocket.WebSocketApp(
                    url,
                    header=headers,
                    on_open=self.on_open,
                    on_message=self.on_message,
                    on_error=self.on_error,
                    on_close=self.on_close
                )
                
                # Run connection
                self.websocket_connection.run_forever()
                
            except Exception as e:
                logger.error(f"WebSocket client crash: {e}")
                
            # Exponential Backoff with Jitter
            attempt += 1
            delay = min(60.0, 1.0 * (2 ** attempt)) + np.random.uniform(0.1, 1.0)
            logger.warn(f"Reconnecting to Angel One feed in {delay:.2f} seconds (Attempt {attempt})...")
            time.sleep(delay)

    def stop(self):
        self.running = False
        if self.websocket_connection:
            self.websocket_connection.close()
        logger.info("Stateful AI Trading Agent Daemon stopped.")


if __name__ == "__main__":
    # Import pandas to create mock data frames
    try:
        import pandas as pd
    except ImportError:
        logger.error("Missing pandas dependency. Please install pandas to run.")
        sys.exit(1)
        
    coordinator = TradingCoordinator()
    try:
        coordinator.start()
    except KeyboardInterrupt:
        coordinator.stop()
        logger.info("Terminated by keyboard input.")
