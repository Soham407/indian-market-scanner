-- Ensure the singleton bot_settings row exists.
-- All columns have defaults, so inserting id=1 is sufficient.
-- The bot-oi-chain edge function updates nifty_current_ltp each run;
-- the bot-premium-decay function updates premium_decay_* fields.
insert into public.bot_settings (id)
values (1)
on conflict (id) do nothing;
