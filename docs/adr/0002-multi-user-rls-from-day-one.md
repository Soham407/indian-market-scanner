# Multi-user RLS from Day One

Market Sniper stores global system-generated alerts but user-owned shadow trades, so Supabase Auth and Row Level Security are enabled from the first schema. Retrofitting ownership rules later would risk leaking portfolio data between users and would force avoidable data migrations.
