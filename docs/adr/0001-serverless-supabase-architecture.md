# Serverless Supabase Architecture

Market Sniper will run as a zero-cost serverless application: Next.js renders the dashboard, Supabase Postgres stores alerts and shadow trades, and Supabase Edge Functions perform scheduled scanning and price refresh work. Dedicated Python servers, FastAPI middleware, and persistent backend instances are intentionally excluded because they violate the infrastructure constraint and would create a second operational backend.
