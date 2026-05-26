#!/bin/bash
# Verify paper trading bot deployment status
# Run this to check if everything is configured correctly

set -e

PROJECT_REF="gykgrrjiqkucstcyrgxp"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}🤖 Paper Trading Bot - Deployment Verification${NC}"
echo "=================================================="
echo ""

# Check 1: Functions deployed
echo "1️⃣  Checking deployed functions..."
FUNCTIONS=$(supabase functions list --project-ref $PROJECT_REF 2>/dev/null || echo "")
if echo "$FUNCTIONS" | grep -q "orb-scanner"; then
  echo -e "  ${GREEN}✓ orb-scanner deployed${NC}"
else
  echo -e "  ${RED}✗ orb-scanner NOT deployed${NC}"
fi

if echo "$FUNCTIONS" | grep -q "check-exits"; then
  echo -e "  ${GREEN}✓ check-exits deployed${NC}"
else
  echo -e "  ${RED}✗ check-exits NOT deployed${NC}"
fi

if echo "$FUNCTIONS" | grep -q "eod-flatten"; then
  echo -e "  ${GREEN}✓ eod-flatten deployed${NC}"
else
  echo -e "  ${RED}✗ eod-flatten NOT deployed${NC}"
fi

if echo "$FUNCTIONS" | grep -q "bot-health-check"; then
  echo -e "  ${GREEN}✓ bot-health-check deployed${NC}"
else
  echo -e "  ${RED}✗ bot-health-check NOT deployed${NC}"
fi

echo ""

# Check 2: Migrations applied
echo "2️⃣  Checking database migrations..."
MIGRATIONS=$(supabase migration list --linked 2>/dev/null | grep "20260520120000\|20260521120000\|20260526120000\|20260526133000" || echo "")

if echo "$MIGRATIONS" | grep "20260520120000"; then
  echo -e "  ${GREEN}✓ bot_config_table migration applied${NC}"
else
  echo -e "  ${RED}✗ bot_config_table migration NOT applied${NC}"
fi

if echo "$MIGRATIONS" | grep "20260526133000"; then
  echo -e "  ${GREEN}✓ bot_schema migration applied${NC}"
else
  echo -e "  ${RED}✗ bot_schema migration NOT applied${NC}"
fi

echo ""

# Check 3: Tables exist
echo "3️⃣  Checking database tables..."
TABLES=$(supabase db query "SELECT count(*) as count FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'bot_%';" --linked -o json 2>/dev/null | grep -o '"count":[0-9]*' || echo "")

if echo "$TABLES" | grep -q "8"; then
  echo -e "  ${GREEN}✓ All bot tables created (8 tables found)${NC}"
else
  echo -e "  ${YELLOW}⚠ Bot tables status unclear${NC}"
fi

echo ""

# Check 4: bot_config initialized
echo "4️⃣  Checking bot_config initialization..."
CONFIG=$(supabase db query "SELECT trading_enabled, circuit_breaker_triggered_at FROM bot_config WHERE id = 1;" --linked -o json 2>/dev/null | grep "trading_enabled\|circuit_breaker" || echo "")

if echo "$CONFIG" | grep -q "true"; then
  echo -e "  ${GREEN}✓ bot_config initialized and trading enabled${NC}"
else
  echo -e "  ${YELLOW}⚠ bot_config status unclear${NC}"
fi

echo ""

# Check 5: Cron jobs scheduled
echo "5️⃣  Checking cron job scheduling..."
CRON=$(supabase db query "SELECT COUNT(*) as count FROM cron.job WHERE jobname LIKE 'bot-%';" --linked -o json 2>/dev/null | grep -o '"count":[0-9]*' || echo "")

if echo "$CRON" | grep -q "4"; then
  echo -e "  ${GREEN}✓ All 4 cron jobs scheduled${NC}"
else
  echo -e "  ${YELLOW}⚠ Cron jobs status unclear (check: ${CRON})${NC}"
fi

echo ""

# Check 6: Vault secrets
echo "6️⃣  Checking vault secrets..."
SECRETS=$(supabase db query "SELECT COUNT(*) as count FROM vault.decrypted_secrets;" --linked -o json 2>/dev/null | grep -o '"count":[0-9]*' || echo "")

if echo "$SECRETS" | grep -q "[2-9]"; then
  echo -e "  ${GREEN}✓ Vault secrets configured${NC}"
else
  echo -e "  ${RED}✗ No vault secrets found - RUN: ./setup-vault-secrets.sh${NC}"
fi

echo ""
echo "=================================================="
echo -e "${YELLOW}📋 Quick Checklist:${NC}"
echo "  ☐ All 4 functions deployed"
echo "  ☐ All migrations applied"
echo "  ☐ All bot tables created"
echo "  ☐ bot_config initialized"
echo "  ☐ 4 cron jobs scheduled"
echo "  ☐ Vault secrets configured"
echo ""
echo -e "${YELLOW}🚀 Go-Live Checklist:${NC}"
echo "  ☐ Run: ./setup-vault-secrets.sh"
echo "  ☐ Verify Telegram notifications work"
echo "  ☐ Monitor next market open (9:15 AM IST)"
echo "  ☐ Check P&L daily"
echo ""
echo "📖 Documentation:"
echo "  • DEPLOYMENT_STATUS.md - Deployment checklist"
echo "  • BOT.md - Full bot documentation"
echo "  • QUICKSTART.md - 10-minute setup guide"
