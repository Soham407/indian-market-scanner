# Stateful AI Trading Agent Daemon

This directory contains the stateful, fully autonomous AI trading agent for the Indian stock market (NSE) using **Nous Hermes 3** and the **Angel One SmartAPI**.

---

## Features

1.  **Stateful Execution:** Maintains persistent WebSocket connections (`Smart Stream 2.0`) to buffer binary tick streams and track the latest bid-ask queues in a local memory cache.
2.  **Autonomous Discretionary Trading:** Scans for 15-minute Opening Range Breakout (ORB) signals, generates visual OHLC charts on breakouts, compiles structured market indicators (VWAP, RSI, OBI, PCR), and prompts Nous Hermes 3 for final execution authorization.
3.  **High-Fidelity Paper Engine:** Models slippage via Depth-of-Market (DOM) walk-the-book calculation, injects 50-150ms execution delay, and aggregates transaction fees updated for post-April 1, 2026 STT rates.
4.  **Risk Guardrails:** Realized/unrealized drawdown circuit breaker (-2.0%), limit of 5 concurrent positions, max 20 daily orders, and a connection Dead-Man's Switch.

---

## Configuration

Set the following environment variables (or save them in a `.env` file at the project root):

```bash
# Supabase Configuration
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key" # Service key required to bypass RLS for bot writes

# Telegram Integration
TELEGRAM_BOT_TOKEN="your-bot-token"
TELEGRAM_CHAT_ID="your-chat-id"

# Angel One SmartAPI Credentials
AngelOne_Apikey="your-api-key"
AngelOne_ClientID="your-client-id"
AngelOne_PIN="your-pin"
AngelOne_SecretKey="your-totp-secret-key"

# Nous Hermes 3 Configuration (OpenAI Compatible)
HERMES_API_BASE="https://api.together.xyz/v1" # or your custom local/cloud provider
HERMES_API_KEY="your-api-key"
HERMES_MODEL="nousresearch/hermes-3-llama-3.1-70b"
```

---

## Running the Agent

### Step 1: Install Dependencies
Ensure you are inside the virtual environment or install dependencies globally:
```bash
pip install -r requirements.txt
```

### Step 2: Run the Daemon
Start the agent process:
```bash
python3 agent/hermes_agent.py
```

It will:
1.  Authenticate with Angel One using your credentials and automatic TOTP generation.
2.  Open the secure binary WebSocket stream.
3.  Monitor market hours (09:15 AM - 03:30 PM IST).
4.  Scan for breakouts and make autonomous execution decisions.
5.  Notify you of entries and exits in real time via Telegram.
