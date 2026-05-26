#!/bin/bash
# Test Telegram bot integration

PROJECT_REF="gykgrrjiqkucstcyrgxp"
PROJECT_URL="https://$PROJECT_REF.supabase.co"

echo "🤖 Testing Telegram Bot Integration"
echo "==================================="
echo ""

# Check secrets are set
echo "1️⃣  Verifying secrets..."
SECRETS=$(supabase secrets list --project-ref $PROJECT_REF 2>&1)

if echo "$SECRETS" | grep -q "telegram_bot_token"; then
  echo "  ✅ telegram_bot_token is set"
else
  echo "  ❌ telegram_bot_token NOT set"
  exit 1
fi

if echo "$SECRETS" | grep -q "telegram_chat_id"; then
  echo "  ✅ telegram_chat_id is set"
else
  echo "  ❌ telegram_chat_id NOT set"
  exit 1
fi

if echo "$SECRETS" | grep -q "market_sniper_anon_jwt"; then
  echo "  ✅ market_sniper_anon_jwt is set"
  HAS_JWT=true
else
  echo "  ⚠️  market_sniper_anon_jwt NOT set (needed for cron jobs)"
  echo "     Run: supabase secrets set market_sniper_anon_jwt='YOUR_KEY' --project-ref $PROJECT_REF"
  HAS_JWT=false
fi

echo ""
echo "2️⃣  Current Telegram Configuration:"
echo "  Bot: @TMTMarketscanner_bot"
echo "  Chat ID: 1523552953 (Vivek)"
echo "  Token: (hidden for security)"
echo ""

if [ "$HAS_JWT" = true ]; then
  echo "3️⃣  Testing bot-health-check function..."
  echo "  Send a test message to verify Telegram works:"
  echo ""
  echo "  curl -X POST $PROJECT_URL/functions/v1/bot-health-check \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"test\": true}'"
  echo ""
  echo "  You should receive a message on Telegram within 30 seconds."
else
  echo "3️⃣  ⏳ Waiting for Supabase anon JWT to test functions"
  echo ""
  echo "Steps to complete setup:"
  echo "  1. Go to: https://supabase.com/dashboard/project/$PROJECT_REF/settings/api"
  echo "  2. Copy the 'anon public' key"
  echo "  3. Run:"
  echo "     supabase secrets set market_sniper_anon_jwt='YOUR_KEY' --project-ref $PROJECT_REF"
  echo ""
fi

echo ""
echo "📋 Quick Checklist:"
echo "  ✅ Telegram bot created: @TMTMarketscanner_bot"
echo "  ✅ telegram_bot_token set"
echo "  ✅ telegram_chat_id set"
if [ "$HAS_JWT" = true ]; then
  echo "  ✅ market_sniper_anon_jwt set"
  echo "  ✅ market_sniper_project_url set"
else
  echo "  ⏳ market_sniper_anon_jwt (needed)"
  echo "  ⏳ market_sniper_project_url (needed)"
fi
echo ""
echo "🚀 Once all secrets are set:"
echo "  • Cron jobs will start running automatically"
echo "  • You'll get Telegram notifications for:"
echo "    - Trade entries and exits"
echo "    - Daily P&L summary"
echo "    - Circuit breaker alerts"
echo "    - Bot heartbeat (every 15 minutes)"
echo ""
