# Managing Supabase Secrets via CLI

You can now manage all bot secrets directly via command line without dashboard access.

## Current Secrets

```bash
supabase secrets list --project-ref gykgrrjiqkucstcyrgxp
```

Currently set:
- ✅ `telegram_bot_token`
- ✅ `telegram_chat_id`
- ⏳ `market_sniper_project_url` (needed for cron jobs)
- ⏳ `market_sniper_anon_jwt` (needed for cron jobs)

## Set/Update a Secret

### Set Telegram Token
```bash
supabase secrets set \
  telegram_bot_token="YOUR_BOT_TOKEN_HERE" \
  --project-ref gykgrrjiqkucstcyrgxp
```

### Set Telegram Chat ID
```bash
supabase secrets set \
  telegram_chat_id="1523552953" \
  --project-ref gykgrrjiqkucstcyrgxp
```

### Set Supabase Project Secrets (Required for Cron Jobs)
```bash
supabase secrets set \
  market_sniper_project_url="https://gykgrrjiqkucstcyrgxp.supabase.co" \
  market_sniper_anon_jwt="eyJhbGciOiJIUzI1NiIs..." \
  --project-ref gykgrrjiqkucstcyrgxp
```

### Set Angel One Broker Secrets (Optional)
```bash
supabase secrets set \
  angel_one_api_key="YOUR_API_KEY" \
  angel_one_client_code="YOUR_CLIENT_CODE" \
  --project-ref gykgrrjiqkucstcyrgxp
```

## Remove a Secret

```bash
supabase secrets unset telegram_bot_token --project-ref gykgrrjiqkucstcyrgxp
```

## Get Your Supabase Anon Key

1. Go to Dashboard: https://supabase.com/dashboard/project/gykgrrjiqkucstcyrgxp/settings/api
2. Find the "Project URL" section
3. Copy the "anon public" key
4. It starts with: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

## Regenerate Telegram Bot Token

If you want to regenerate the Telegram token for security:

1. Message @BotFather on Telegram
2. Select your bot `/mybots` → `TMTMarketscanner_bot` → `Edit Token`
3. Get the new token
4. Update with:
```bash
supabase secrets set \
  telegram_bot_token="NEW_TOKEN_HERE" \
  --project-ref gykgrrjiqkucstcyrgxp
```

## Rotate Secrets Safely

To rotate secrets without downtime:

1. Create new secret with different name (e.g., `telegram_bot_token_v2`)
2. Update function code to use new secret
3. Deploy function
4. Remove old secret with `supabase secrets unset`

## Security Best Practices

- ✅ Never commit secrets to git
- ✅ Rotate tokens periodically  
- ✅ Use separate bot for different environments (dev/prod)
- ✅ Store backup of tokens in secure location
- ✅ Check `.gitignore` excludes `.env` and vault files

## Next Steps

1. Get your Supabase anon key from dashboard
2. Set the project secrets:
```bash
supabase secrets set \
  market_sniper_project_url="https://gykgrrjiqkucstcyrgxp.supabase.co" \
  market_sniper_anon_jwt="YOUR_ANON_KEY" \
  --project-ref gykgrrjiqkucstcyrgxp
```

3. Verify all secrets are set:
```bash
supabase secrets list --project-ref gykgrrjiqkucstcyrgxp
```

4. Test the bot-health-check function to verify Telegram works:
```bash
curl -X POST https://gykgrrjiqkucstcyrgxp.supabase.co/functions/v1/bot-health-check \
  -H 'Content-Type: application/json' \
  -d '{"test": true}'
```

5. You should get a message on Telegram from `@TMTMarketscanner_bot`
