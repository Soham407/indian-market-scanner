#!/bin/bash
# Setup Supabase Vault Secrets for Paper Trading Bot
# Run this script to configure all required secrets

set -e

PROJECT_REF="gykgrrjiqkucstcyrgxp"
PROJECT_URL="https://gykgrrjiqkucstcyrgxp.supabase.co"

echo "🔐 Supabase Vault Secrets Setup"
echo "================================"
echo "Project Reference: $PROJECT_REF"
echo "Project URL: $PROJECT_URL"
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}⚠️  This script requires manual setup in Supabase Dashboard${NC}"
echo ""
echo "Step 1: Go to Supabase Dashboard"
echo "  → https://supabase.com/dashboard/project/$PROJECT_REF/settings/vault"
echo ""

echo "Step 2: Get your Supabase API Keys"
echo "  → Go to Settings → API"
echo "  → Copy the 'anon public' key"
echo "  → Copy the 'service_role' key"
echo ""

read -p "Enter your Supabase anon key: " ANON_KEY
read -p "Enter your Supabase service role key: " SERVICE_ROLE_KEY

echo ""
echo "Step 3: Configure Vault Secrets in Dashboard"
echo "  Go to: Settings → Vault → New Secret"
echo ""

# Helper function to show secret setup instructions
setup_secret() {
  local name=$1
  local value=$2
  local description=$3

  echo -e "${GREEN}Secret: $name${NC}"
  echo "  Description: $description"
  echo "  Value (copy this): $value"
  echo ""
}

echo "📋 Required Secrets to Create:"
echo ""

setup_secret \
  "market_sniper_project_url" \
  "$PROJECT_URL" \
  "Supabase project URL for cron jobs"

setup_secret \
  "market_sniper_anon_jwt" \
  "$ANON_KEY" \
  "Anonymous JWT token for function authorization"

echo -e "${YELLOW}📱 Telegram Integration (Required for Notifications)${NC}"
read -p "Enter your Telegram Bot Token (@BotFather): " TELEGRAM_BOT_TOKEN
read -p "Enter your Telegram Chat ID (@userinfobot): " TELEGRAM_CHAT_ID

setup_secret \
  "telegram_bot_token" \
  "$TELEGRAM_BOT_TOKEN" \
  "Telegram bot token for notifications"

setup_secret \
  "telegram_chat_id" \
  "$TELEGRAM_CHAT_ID" \
  "Your Telegram user/channel ID for receiving alerts"

echo -e "${YELLOW}🏢 Angel One Integration (Optional for Live Trading)${NC}"
read -p "Do you have Angel One broker credentials? (y/n): " HAS_ANGEL_ONE

if [[ "$HAS_ANGEL_ONE" == "y" || "$HAS_ANGEL_ONE" == "Y" ]]; then
  read -p "Enter Angel One API Key: " ANGEL_ONE_API_KEY
  read -p "Enter Angel One Client Code: " ANGEL_ONE_CLIENT_CODE

  setup_secret \
    "angel_one_api_key" \
    "$ANGEL_ONE_API_KEY" \
    "Angel One broker API key"

  setup_secret \
    "angel_one_client_code" \
    "$ANGEL_ONE_CLIENT_CODE" \
    "Angel One client code"
fi

echo ""
echo -e "${GREEN}✅ Next Steps:${NC}"
echo "1. Create all secrets in Supabase Vault dashboard (shown above)"
echo "2. Verify secrets are saved"
echo "3. Run: supabase functions invoke orb-scanner --linked"
echo "4. Check Telegram for first heartbeat message"
echo ""
echo -e "${YELLOW}Documentation:${NC}"
echo "  Deployment: ./DEPLOYMENT_STATUS.md"
echo "  Bot Guide: ./BOT.md"
echo "  Quick Start: ./QUICKSTART.md"
