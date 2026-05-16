"use client";

import { CheckCircle2, Crosshair, LogIn, LogOut, Mail, Moon, Sun, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { getThemeClasses, type Theme, type ThemeClasses } from "@/lib/theme";
import { LandingContent } from "./landing-content";
import { MarketSniperDashboard } from "./market-sniper-dashboard";

type AuthState = "checking" | "signed-in" | "signed-out" | "unconfigured";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getSiteUrl() {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL;
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return "";
}

export function LandingPage() {
  const configured = isSupabaseConfigured();
  const [authState, setAuthState] = useState<AuthState>(
    configured ? "checking" : "unconfigured",
  );
  const [userId, setUserId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signInSubmitting, setSignInSubmitting] = useState(false);
  // Address the magic link was sent to; non-null = success state in modal.
  const [signInSentTo, setSignInSentTo] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const supabase = useMemo(() => createBrowserClient(), []);
  const ui = getThemeClasses(theme);

  useEffect(() => {
    queueMicrotask(() => {
      const storedTheme = window.localStorage.getItem("market-sniper-theme");
      if (storedTheme === "dark" || storedTheme === "light") {
        setTheme(storedTheme);
        return;
      }
      setTheme(
        window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
      );
    });
  }, []);

  function toggleTheme() {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      window.localStorage.setItem("market-sniper-theme", next);
      return next;
    });
  }

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let mounted = true;

    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) {
        return;
      }
      const user = data.user;
      setUserId(user?.id ?? null);
      setAuthState(user ? "signed-in" : "signed-out");
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUserId(session?.user.id ?? null);
        setAuthState(session?.user ? "signed-in" : "signed-out");
      },
    );

    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [supabase]);

  function openSignIn() {
    if (!supabase) {
      setAuthState("unconfigured");
      setNotice("Supabase env vars are not configured.");
      return;
    }
    setSignInError(null);
    setSignInSentTo(null);
    setSignInOpen(true);
  }

  function closeSignIn() {
    if (signInSubmitting) {
      return;
    }
    setSignInOpen(false);
    setSignInError(null);
    setSignInSentTo(null);
  }

  async function submitSignIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setSignInError("Supabase env vars are not configured.");
      return;
    }

    const email = signInEmail.trim();
    if (!EMAIL_PATTERN.test(email)) {
      setSignInError("Enter a valid email address.");
      return;
    }

    setSignInSubmitting(true);
    setSignInError(null);

    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: getSiteUrl() },
      });

      if (error) {
        setSignInError(error.message);
        return;
      }

      // Keep the modal open with a clear success state. The tiny toast
      // alone was easy to miss, leading to re-submission anxiety.
      setSignInSentTo(email);
    } catch (caught) {
      setSignInError(
        caught instanceof Error ? caught.message : "Network error sending magic link.",
      );
    } finally {
      setSignInSubmitting(false);
    }
  }

  async function signOut() {
    if (!supabase) {
      return;
    }
    const { error } = await supabase.auth.signOut();
    if (error) {
      setNotice(`Sign out failed: ${error.message}`);
      return;
    }
    setNotice("Signed out.");
  }

  const isSignedIn = authState === "signed-in" && userId !== null;

  return (
    <main className={`min-h-screen transition-colors ${ui.page}`}>
      <div className={`sticky top-0 z-40 border-b backdrop-blur-md ${ui.header}`}>
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className={`flex items-center gap-3 ${ui.accentText}`}>
                <Crosshair className="size-6" />
                <span className="font-mono text-xs uppercase tracking-[0.28em]">
                  Market Sniper
                </span>
              </div>
              <h1
                className={`mt-3 text-3xl font-semibold tracking-normal sm:text-4xl ${ui.heading}`}
              >
                Institutional liquidity trap monitor
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm transition ${ui.outlineButton}`}
                onClick={toggleTheme}
              >
                {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                {theme === "dark" ? "Light" : "Dark"}
              </button>
              {isSignedIn ? (
                <button
                  className={`inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-semibold transition ${ui.outlineButton}`}
                  onClick={signOut}
                  type="button"
                >
                  <LogOut className="size-4" />
                  Sign out
                </button>
              ) : (
                <button
                  className={`inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-semibold transition ${ui.primaryButton}`}
                  onClick={openSignIn}
                  type="button"
                >
                  <LogIn className="size-4" />
                  Sign in
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {isSignedIn && supabase ? (
        <MarketSniperDashboard supabase={supabase} userId={userId} ui={ui} />
      ) : (
        <LandingContent
          ui={ui}
          theme={theme}
          authState={authState}
          onSignIn={openSignIn}
        />
      )}

      {notice ? (
        <button
          className={`fixed bottom-4 left-1/2 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border px-4 py-3 text-left text-sm shadow-2xl ${ui.toast}`}
          onClick={() => setNotice(null)}
        >
          <span>{notice}</span>
          <X className={`size-4 ${ui.mutedText}`} />
        </button>
      ) : null}

      {signInOpen ? (
        <SignInModal
          email={signInEmail}
          error={signInError}
          submitting={signInSubmitting}
          sentTo={signInSentTo}
          onChange={setSignInEmail}
          onSubmit={submitSignIn}
          onClose={closeSignIn}
          onResend={() => setSignInSentTo(null)}
          ui={ui}
        />
      ) : null}
    </main>
  );
}

function SignInModal({
  email,
  error,
  submitting,
  sentTo,
  onChange,
  onSubmit,
  onClose,
  onResend,
  ui,
}: {
  email: string;
  error: string | null;
  submitting: boolean;
  sentTo: string | null;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  onResend: () => void;
  ui: ThemeClasses;
}) {
  const isSuccess = sentTo !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sign-in-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      {isSuccess ? (
        <div
          className={`w-full max-w-md rounded-lg border p-6 shadow-2xl ${ui.card}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2
                id="sign-in-title"
                className={`flex items-center gap-2 text-lg font-semibold ${ui.heading}`}
              >
                <CheckCircle2 className={`size-5 ${ui.positiveText}`} />
                Check your email
              </h2>
              <p className={`mt-1 text-sm ${ui.secondaryText}`}>
                We sent a magic link to{" "}
                <span className={`font-mono ${ui.heading}`}>{sentTo}</span>.
                Click the link to finish signing in — it expires in about an
                hour.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close sign in"
              className={`inline-flex size-8 items-center justify-center rounded-md border ${ui.outlineButton}`}
            >
              <X className="size-4" />
            </button>
          </div>

          <div
            className={`mt-5 flex items-start gap-3 rounded-md border px-3 py-3 ${ui.subtlePanel}`}
          >
            <Mail className={`mt-0.5 size-4 ${ui.mutedText}`} />
            <p className={`text-xs leading-5 ${ui.secondaryText}`}>
              Didn&apos;t arrive? Check spam, then send again — magic links
              sometimes lose a race against your inbox provider.
            </p>
          </div>

          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={onResend}
              className={`inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md border text-sm font-medium transition ${ui.outlineButton}`}
            >
              Resend to a different address
            </button>
            <button
              type="button"
              onClick={onClose}
              className={`inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md text-sm font-semibold transition ${ui.primaryButton}`}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
      <form
        onSubmit={onSubmit}
        className={`w-full max-w-md rounded-lg border p-6 shadow-2xl ${ui.card}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="sign-in-title" className={`text-lg font-semibold ${ui.heading}`}>
              Sign in to Market Sniper
            </h2>
            <p className={`mt-1 text-sm ${ui.secondaryText}`}>
              We will email you a magic link to sign in.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close sign in"
            className={`inline-flex size-8 items-center justify-center rounded-md border ${ui.outlineButton}`}
          >
            <X className="size-4" />
          </button>
        </div>

        <label
          htmlFor="sign-in-email"
          className={`mt-5 block text-xs uppercase tracking-[0.18em] ${ui.mutedText}`}
        >
          Email address
        </label>
        <input
          id="sign-in-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          onChange={(event) => onChange(event.target.value)}
          disabled={submitting}
          className={`mt-2 h-11 w-full rounded-md border px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-emerald-500/40 ${ui.subtlePanel} ${ui.heading}`}
          placeholder="you@example.com"
        />

        {error ? (
          <p className={`mt-3 text-sm ${ui.negativeText}`} role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className={`mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold transition ${ui.primaryButton} disabled:opacity-60`}
        >
          <LogIn className="size-4" />
          {submitting ? "Sending..." : "Send magic link"}
        </button>
      </form>
      )}
    </div>
  );
}

