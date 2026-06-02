# Options Dashboard — Whitelisted Auth + Single Active Session

**Date:** 2026-06-02  
**Scope:** `bot/` Next.js app only

## Problem

The options premium decay dashboard (`bot/`) is currently unprotected — anyone with the URL can view it. The owner wants only a small set of trusted emails to access it, and no more than one active session per account at a time.

## Goals

1. Gate the dashboard behind Google OAuth via Supabase Auth
2. Only emails listed in `allowed_emails` can sign in successfully
3. If a second device signs in with the same account, the first device is kicked out immediately via Supabase Realtime

## Non-goals

- No role-based permissions (all allowed users see the same dashboard)
- No self-service registration or invite flow
- No changes to the `dashboard/` app

---

## Data Model

### Migration: `supabase/migrations/20260602120000_allowed_emails.sql`

```sql
CREATE TABLE allowed_emails (
  email         TEXT PRIMARY KEY,
  session_nonce TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read only their own row (required for Realtime)
CREATE POLICY "read own row"
  ON allowed_emails FOR SELECT
  USING ((auth.jwt() ->> 'email') = email);

-- No user-level INSERT/UPDATE/DELETE — all writes use service role via server route
```

Populate manually via Supabase dashboard SQL editor:

```sql
INSERT INTO allowed_emails (email) VALUES
  ('you@gmail.com'),
  ('trusted@gmail.com');
```

---

## Prerequisites (manual, done once in Supabase dashboard)

1. **Supabase → Authentication → Providers → Google**: enable, paste Google OAuth client ID + secret
2. **Google Cloud Console → OAuth consent screen**: add your Vercel domain to authorised origins
3. **Google Cloud Console → Credentials**: add `https://<your-domain>/auth/callback` as an authorised redirect URI
4. **Supabase → Authentication → URL Configuration**: set Site URL to production domain; add `http://localhost:3000/auth/callback` to redirect allow-list for local dev

---

## Architecture

### Package addition

```
@supabase/ssr   — official Next.js App Router integration for cookie-based sessions
```

### New / modified files

| File | Action | Purpose |
|------|--------|---------|
| `bot/src/middleware.ts` | NEW | Protect all routes; redirect unauthenticated requests to `/login` |
| `bot/src/lib/supabase-server.ts` | NEW | `createServerClient` helper for route handlers + server components |
| `bot/src/lib/supabase-browser.ts` | MODIFY | Replace bare client with `createBrowserClient` from `@supabase/ssr` |
| `bot/src/app/login/page.tsx` | NEW | Google sign-in page with error message support |
| `bot/src/app/auth/callback/route.ts` | NEW | OAuth exchange, whitelist check, nonce write |
| `bot/src/components/session-guard.tsx` | NEW | Realtime subscription; signs out on nonce change |
| `bot/src/app/page.tsx` | MODIFY | Wrap dashboard content with `<SessionGuard>` |
| `bot/package.json` | MODIFY | Add `@supabase/ssr` |

---

## Auth Flow

```
User hits /
  └─ middleware: no session?
       └─ redirect → /login

/login
  └─ "Sign in with Google" button
       └─ supabase.auth.signInWithOAuth({ provider: 'google', redirectTo: '/auth/callback' })

Google OAuth completes → /auth/callback (Route Handler, server-side)
  ├─ Exchange code for session (supabase.auth.exchangeCodeForSession)
  ├─ Get email from session.user.email
  ├─ Query allowed_emails using service role
  │    ├─ NOT FOUND → signOut() → redirect /login?error=not_allowed
  │    └─ FOUND → crypto.randomUUID() → UPDATE allowed_emails SET session_nonce = nonce
  └─ redirect → /

/ (dashboard)
  └─ SessionGuard mounts
       └─ Realtime SUBSCRIBE on allowed_emails WHERE email = current user
            └─ On UPDATE → signOut() → redirect /login?error=signed_out_elsewhere
```

---

## Component Designs

### `middleware.ts`

- Uses `createServerClient` with cookie read/write handlers from `next/headers`
- Calls `supabase.auth.getUser()` — authoritative server-side check (not `getSession()`)
- Pass-through routes: `/login`, `/auth/callback`, and Next.js internals (`_next/static`, `_next/image`, `favicon.ico`)
- Redirect preserves `?error=` params on the login page so they survive the redirect

### `login/page.tsx`

- Reads `?error=` from `searchParams`:
  - `not_allowed` → "Your account isn't authorised to access this dashboard"
  - `signed_out_elsewhere` → "You were signed in from another device"
- Single "Sign in with Google" button — calls a Server Action that invokes `signInWithOAuth`
- Styled to match the dashboard: slate/glassmorphism card, same font and colour palette

### `auth/callback/route.ts` (GET handler)

```
1. supabase.auth.exchangeCodeForSession(code from URL)
2. If exchange fails → redirect /login?error=not_allowed
3. Query allowed_emails with service role supabase client
4. Email not in table → supabase.auth.signOut() → redirect /login?error=not_allowed
5. Generate nonce = crypto.randomUUID()
6. UPDATE allowed_emails SET session_nonce = nonce WHERE email = user.email (service role)
7. Redirect /
```

### `session-guard.tsx`

```tsx
"use client"
// Props: children, userEmail
// On mount:
//   1. Subscribe to postgres_changes UPDATE on allowed_emails filtered by email
//   2. On event received → supabase.auth.signOut() → router.push('/login?error=signed_out_elsewhere')
// On unmount: remove channel
// Renders children normally — no loading state, no UI of its own
```

### `supabase-browser.ts` (modified)

Replace current bare `createClient` (which has `persistSession: false`) with `createBrowserClient` from `@supabase/ssr`. This uses cookies for session storage, which middleware can read server-side.

---

## Security Properties

| Threat | Mitigation |
|--------|-----------|
| Unauthenticated URL access | `middleware.ts` blocks server-side before any HTML is sent |
| Non-whitelisted Google account | Auth callback checks `allowed_emails` and signs out immediately |
| Session sharing across devices | Nonce overwrite on new login + Realtime kick-out on old device |
| Stale session after kick-out | `supabase.auth.signOut()` clears cookie; middleware will redirect on next request |
| Service role key exposure | Only used in server-side route handler, never sent to client |

---

## Verification

1. **Happy path:** Sign in with a whitelisted Google account → lands on dashboard
2. **Whitelist rejection:** Sign in with a non-whitelisted account → redirected to `/login` with "not authorised" message
3. **Single session:** Sign in on device A → open new browser/device B → sign in → device A is redirected to `/login` with "signed in from another device" message within seconds
4. **Direct URL access:** Open `/` in a fresh incognito window → redirected to `/login`
5. **Sign out:** (optional sign-out button) clears cookie → middleware redirects to `/login`
