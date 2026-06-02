# Options Dashboard Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the `bot/` Next.js options dashboard behind Google OAuth with email whitelist and single-active-session enforcement via Supabase Realtime.

**Architecture:** Middleware reads a cookie-based session server-side on every request and redirects unauthenticated users to `/login`. The `/auth/callback` route handler checks the user's email against an `allowed_emails` Supabase table and writes a new `session_nonce` on each successful login. A `SessionGuard` client component subscribes to Realtime on that row — any nonce change means another device logged in, so it signs out immediately.

**Tech Stack:** Next.js 16 App Router, `@supabase/ssr` (cookie-based sessions), Supabase Auth (Google OAuth), Supabase Realtime (Postgres Changes), Vitest

---

## Prerequisites (manual — done once before running the app)

1. **Supabase dashboard → Authentication → Providers → Google**: enable, paste your Google OAuth Client ID + Secret
2. **Google Cloud Console → OAuth consent screen**: add your deployed domain to authorised origins
3. **Google Cloud Console → Credentials → your OAuth client**: add `https://<your-domain>/auth/callback` and `http://localhost:3000/auth/callback` as authorised redirect URIs
4. **Supabase dashboard → Authentication → URL Configuration**: set Site URL; add `http://localhost:3000/auth/callback` to the redirect allow-list
5. **`bot/.env.local`**: add `SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>` (found in Supabase dashboard → Project Settings → API)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `bot/package.json` | Modify | Add `@supabase/ssr` dependency |
| `bot/src/lib/supabase-browser.ts` | Modify | Replace bare client with `createBrowserClient` from `@supabase/ssr` |
| `bot/src/lib/supabase-server.ts` | Create | `createServerClient` factory for server components + route handlers |
| `bot/src/middleware.ts` | Create | Protect all routes; redirect unauthenticated to `/login` |
| `supabase/migrations/20260602120000_allowed_emails.sql` | Create | `allowed_emails` table + RLS |
| `bot/src/app/auth/callback/route.ts` | Create | OAuth code exchange, whitelist check, nonce write |
| `bot/src/app/login/_login-form.tsx` | Create | Client component: Google sign-in button + error messages |
| `bot/src/app/login/page.tsx` | Create | Server component: Suspense wrapper for login form |
| `bot/src/components/session-guard.tsx` | Create | Realtime subscription; signs out on nonce change |
| `bot/src/components/dashboard.tsx` | Create | Current `page.tsx` client logic + sign-out button |
| `bot/src/app/page.tsx` | Modify | Slim server component: get user, wrap Dashboard with SessionGuard |

---

## Task 1: Install `@supabase/ssr` and update Supabase clients

**Files:**
- Modify: `bot/package.json`
- Modify: `bot/src/lib/supabase-browser.ts`
- Create: `bot/src/lib/supabase-server.ts`

- [ ] **Step 1: Install `@supabase/ssr`**

```bash
cd bot && npm install @supabase/ssr
```

Expected: package added to `node_modules`, `package.json` updated with `"@supabase/ssr": "^0.x.x"`.

- [ ] **Step 2: Replace `supabase-browser.ts` with `createBrowserClient`**

Replace the entire content of `bot/src/lib/supabase-browser.ts`:

```typescript
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getBrowserSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  client = createBrowserClient(url, anonKey);
  return client;
}
```

- [ ] **Step 3: Create `bot/src/lib/supabase-server.ts`**

```typescript
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function getServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — cookie writes are a no-op here, safe to ignore
          }
        },
      },
    },
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd bot && npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add bot/package.json bot/package-lock.json bot/src/lib/supabase-browser.ts bot/src/lib/supabase-server.ts
git commit -m "feat(bot): add @supabase/ssr, update browser client, add server client factory"
```

---

## Task 2: Database migration — `allowed_emails` table

**Files:**
- Create: `supabase/migrations/20260602120000_allowed_emails.sql`

- [ ] **Step 1: Create the migration file**

Create `supabase/migrations/20260602120000_allowed_emails.sql`:

```sql
-- Whitelist of emails permitted to access the bot dashboard.
-- session_nonce is overwritten on each new login; old devices sign out via Realtime when it changes.
CREATE TABLE allowed_emails (
  email         TEXT PRIMARY KEY,
  session_nonce TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;

-- Authenticated users can SELECT their own row only (required for Realtime subscription).
-- All INSERT/UPDATE/DELETE use the service role key server-side — no user-level write access.
CREATE POLICY "read own row"
  ON allowed_emails
  FOR SELECT
  USING ((auth.jwt() ->> 'email') = email);
```

- [ ] **Step 2: Apply the migration**

```bash
cd /path/to/project && supabase db push
```

Or apply manually via Supabase dashboard → SQL editor.

- [ ] **Step 3: Seed your allowed emails**

In Supabase dashboard SQL editor:

```sql
INSERT INTO allowed_emails (email) VALUES
  ('your-email@gmail.com'),
  ('trusted-email@gmail.com');
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260602120000_allowed_emails.sql
git commit -m "feat(supabase): add allowed_emails table with RLS for dashboard whitelist"
```

---

## Task 3: Auth callback route handler

**Files:**
- Create: `bot/src/app/auth/callback/route.ts`

- [ ] **Step 1: Create `bot/src/app/auth/callback/route.ts`**

```typescript
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=not_allowed`);
  }

  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        },
      },
    },
  );

  const { data: { session }, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !session) {
    return NextResponse.redirect(`${origin}/login?error=not_allowed`);
  }

  const email = session.user.email?.toLowerCase();

  if (!email) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=not_allowed`);
  }

  // Use service role to bypass RLS for the whitelist check and nonce write
  const adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: allowed } = await adminClient
    .from("allowed_emails")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (!allowed) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=not_allowed`);
  }

  // Overwrite session_nonce — this triggers a Realtime UPDATE on any other active session,
  // which causes that device's SessionGuard to sign out immediately.
  const nonce = crypto.randomUUID();
  await adminClient
    .from("allowed_emails")
    .update({ session_nonce: nonce })
    .eq("email", email);

  return NextResponse.redirect(origin);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd bot && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add bot/src/app/auth/callback/route.ts
git commit -m "feat(bot): add /auth/callback route — whitelist check and session nonce write"
```

---

## Task 4: Middleware — protect all routes

**Files:**
- Create: `bot/src/middleware.ts`

- [ ] **Step 1: Create `bot/src/middleware.ts`**

```typescript
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = ["/login", "/auth/callback"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() makes an authoritative server-side check — never use getSession() in middleware
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Skip Next.js internals and static assets
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd bot && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add bot/src/middleware.ts
git commit -m "feat(bot): add middleware — redirect unauthenticated requests to /login"
```

---

## Task 5: Login page

**Files:**
- Create: `bot/src/app/login/_login-form.tsx`
- Create: `bot/src/app/login/page.tsx`

- [ ] **Step 1: Create `bot/src/app/login/_login-form.tsx`**

```tsx
"use client";

import { useSearchParams } from "next/navigation";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: "Your account isn't authorised to access this dashboard.",
  signed_out_elsewhere: "You were signed in from another device.",
};

export function LoginForm() {
  const searchParams = useSearchParams();
  const errorKey = searchParams.get("error");
  const errorMessage = errorKey ? (ERROR_MESSAGES[errorKey] ?? "Something went wrong. Please try again.") : null;

  const handleSignIn = async () => {
    const supabase = getBrowserSupabaseClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.12),_transparent_35%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)] p-4">
      <div className="w-full max-w-sm rounded-[1.5rem] border border-white/60 bg-white/70 px-8 py-10 shadow-[0_20px_60px_-35px_rgba(15,23,42,0.5)] backdrop-blur">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">
          Indian Market Scanner
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">Sign in</h1>
        <p className="mt-2 text-sm text-slate-600">Access is restricted to authorised accounts.</p>

        {errorMessage ? (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {errorMessage}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => void handleSignIn()}
          className="mt-6 flex w-full items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50 active:scale-[0.98]"
        >
          <GoogleIcon />
          Sign in with Google
        </button>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}
```

- [ ] **Step 2: Create `bot/src/app/login/page.tsx`**

```tsx
import { Suspense } from "react";
import { LoginForm } from "./_login-form";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd bot && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add bot/src/app/login/
git commit -m "feat(bot): add /login page with Google OAuth button and error messages"
```

---

## Task 6: SessionGuard component + Dashboard extraction + page.tsx update

**Files:**
- Create: `bot/src/components/session-guard.tsx`
- Create: `bot/src/components/dashboard.tsx`
- Modify: `bot/src/app/page.tsx`

- [ ] **Step 1: Create `bot/src/components/session-guard.tsx`**

```tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";

type SessionGuardProps = {
  userEmail: string;
  children: React.ReactNode;
};

export function SessionGuard({ userEmail, children }: SessionGuardProps) {
  const router = useRouter();

  useEffect(() => {
    const supabase = getBrowserSupabaseClient();

    const channel = supabase
      .channel("session-guard")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "allowed_emails",
          filter: `email=eq.${userEmail}`,
        },
        () => {
          void supabase.auth.signOut().then(() => {
            router.push("/login?error=signed_out_elsewhere");
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userEmail, router]);

  return <>{children}</>;
}
```

- [ ] **Step 2: Create `bot/src/components/dashboard.tsx`**

Copy the entire content of `bot/src/app/page.tsx` into `bot/src/components/dashboard.tsx`, then make two changes:

**a)** Change the export from `export default function HomePage()` to `export function Dashboard()`

**b)** Add a sign-out button inside the `<header>` flex row alongside the status cards. Place it after the two status card `<div>` elements, inside the `<div className="flex flex-col gap-3 sm:flex-row">`:

```tsx
<button
  type="button"
  onClick={() => {
    const supabase = getBrowserSupabaseClient();
    void supabase.auth.signOut().then(() => {
      window.location.href = "/login";
    });
  }}
  className="self-start rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 sm:self-center"
>
  Sign out
</button>
```

The full header `<div>` for the right-side controls should look like:

```tsx
<div className="flex flex-col gap-3 sm:flex-row">
  {/* Bot heartbeat card — unchanged */}
  <div className={`rounded-2xl border px-4 py-3 shadow-sm ${...}`}>
    ...
  </div>
  {/* Options collector card — unchanged */}
  <div className={`rounded-2xl border px-4 py-3 shadow-sm ${...}`}>
    ...
  </div>
  {/* Sign out button — NEW */}
  <button
    type="button"
    onClick={() => {
      const supabase = getBrowserSupabaseClient();
      void supabase.auth.signOut().then(() => {
        window.location.href = "/login";
      });
    }}
    className="self-start rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 sm:self-center"
  >
    Sign out
  </button>
</div>
```

- [ ] **Step 3: Replace `bot/src/app/page.tsx` with a slim server component**

Replace the entire content of `bot/src/app/page.tsx` with:

```tsx
import { redirect } from "next/navigation";
import { getServerSupabaseClient } from "@/lib/supabase-server";
import { SessionGuard } from "@/components/session-guard";
import { Dashboard } from "@/components/dashboard";

export default async function HomePage() {
  const supabase = await getServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user?.email) {
    redirect("/login");
  }

  return (
    <SessionGuard userEmail={user.email}>
      <Dashboard />
    </SessionGuard>
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd bot && npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Run existing tests to confirm nothing regressed**

```bash
cd bot && npm test
```

Expected: all existing tests pass (heartbeat, options-chart-ui, premium-decay).

- [ ] **Step 6: Commit**

```bash
git add bot/src/components/session-guard.tsx bot/src/components/dashboard.tsx bot/src/app/page.tsx
git commit -m "feat(bot): add SessionGuard for Realtime kick-out, extract Dashboard component, slim page.tsx"
```

---

## Task 7: End-to-end verification

Run the dev server and manually verify each scenario.

- [ ] **Step 1: Start dev server**

```bash
cd bot && npm run dev
```

- [ ] **Step 2: Direct URL access (no session)**

Open `http://localhost:3000` in a fresh incognito window.

Expected: immediately redirected to `http://localhost:3000/login`.

- [ ] **Step 3: Non-whitelisted Google account**

On the login page, click "Sign in with Google". Sign in with a Google account whose email is NOT in `allowed_emails`.

Expected: redirected to `/login?error=not_allowed` with message "Your account isn't authorised to access this dashboard."

- [ ] **Step 4: Whitelisted Google account (happy path)**

Sign in with a whitelisted email.

Expected: redirected to `/` and the full dashboard loads. Bot heartbeat, status cards, and chart are visible.

- [ ] **Step 5: Session persists on refresh**

Hard-refresh the dashboard page (`Cmd+Shift+R`).

Expected: dashboard loads without redirecting to login (session cookie persists).

- [ ] **Step 6: Sign out**

Click the "Sign out" button in the dashboard header.

Expected: redirected to `/login`. Navigating back to `/` redirects back to `/login`.

- [ ] **Step 7: Single active session (kick-out)**

a. Sign in on device/browser A → confirm dashboard is visible  
b. Open a second browser profile (or another device) and sign in with the same whitelisted account  
c. Watch device A

Expected: within a few seconds, device A is redirected to `/login?error=signed_out_elsewhere` with message "You were signed in from another device." Device B remains on the dashboard.

- [ ] **Step 8: Commit verification notes**

If all checks pass:

```bash
git tag auth-verified-$(date +%Y%m%d)
```

---

## Self-Review Notes

- **Spec coverage:** All five spec sections implemented — data model (Task 2), auth flow (Tasks 3+5), route protection (Task 4), session guard (Task 6), prerequisites (manual steps at top).
- **No placeholders:** All steps contain actual code.
- **Type consistency:** `getBrowserSupabaseClient()` used consistently in browser contexts; `getServerSupabaseClient()` used in server contexts; `SessionGuard` props (`userEmail: string`, `children: React.ReactNode`) match usage in `page.tsx`.
- **Note:** No unit tests added for this feature — the auth code is pure framework integration (Supabase + Next.js). The existing pure-function test files (`heartbeat.test.ts`, `options-chart-ui.test.ts`, `premium-decay.test.ts`) are unaffected. Verification is manual (Task 7).
