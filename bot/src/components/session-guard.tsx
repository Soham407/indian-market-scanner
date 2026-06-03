"use client";

import { useEffect, useRef, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

type SessionGuardProps = {
  userEmail: string;
  children: React.ReactNode;
};

export function SessionGuard({ userEmail, children }: SessionGuardProps) {
  const sessionIdRef = useRef<string>(crypto.randomUUID());
  const [isLocked, setIsLocked] = useState(false);

  useEffect(() => {
    const supabase = getBrowserSupabaseClient();
    const mySessionId = sessionIdRef.current;
    let isActive = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let expireTimeout: ReturnType<typeof setTimeout> | null = null;

    const signOutExpired = () => {
      void supabase.auth.signOut().then(() => {
        window.location.href = "/login?error=session_expired";
      });
    };

    const checkNonce = async () => {
      const { data } = await supabase
        .from("allowed_emails")
        .select("session_nonce, session_started_at")
        .eq("email", userEmail)
        .maybeSingle();
      if (!isActive) return;

      if (data?.session_nonce && data.session_nonce !== mySessionId) {
        setIsLocked(true);
        return;
      }

      // Polling fallback for the 12-hour expiry — catches the case where the
      // setTimeout below didn't fire (e.g. device was asleep).
      if (data?.session_started_at) {
        const elapsed = Date.now() - new Date(data.session_started_at).getTime();
        if (elapsed > TWELVE_HOURS_MS) {
          signOutExpired();
        }
      }
    };

    const init = async () => {
      // createBrowserClient reads the session from cookies asynchronously.
      // Without this, the Realtime socket connects before the JWT is set and
      // subscribes as anonymous — RLS blocks all events silently.
      const { data: { session } } = await supabase.auth.getSession();
      if (!isActive) return;
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }

      channel = supabase
        .channel(`session-guard-${mySessionId}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "allowed_emails" },
          (payload) => {
            const row = payload.new as {
              email?: string;
              session_nonce?: string | null;
              session_started_at?: string | null;
            };
            if (row.email !== userEmail) return;
            if (row.session_nonce && row.session_nonce !== mySessionId) {
              setIsLocked(true);
              return;
            }
            if (row.session_started_at) {
              const elapsed = Date.now() - new Date(row.session_started_at).getTime();
              if (elapsed > TWELVE_HOURS_MS) signOutExpired();
            }
          },
        )
        .subscribe();

      // Claim this tab's session, then verify the DB confirms our nonce.
      await fetch("/api/session/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: mySessionId }),
      });

      // Fetch session_started_at once and schedule an exact setTimeout for the
      // remaining time until 12 hours. This triggers even if polling is paused.
      const { data } = await supabase
        .from("allowed_emails")
        .select("session_nonce, session_started_at")
        .eq("email", userEmail)
        .maybeSingle();
      if (!isActive) return;

      if (data?.session_nonce && data.session_nonce !== mySessionId) {
        setIsLocked(true);
        return;
      }

      if (data?.session_started_at) {
        const elapsed = Date.now() - new Date(data.session_started_at).getTime();
        const remaining = TWELVE_HOURS_MS - elapsed;
        if (remaining <= 0) {
          signOutExpired();
          return;
        }
        expireTimeout = setTimeout(signOutExpired, remaining);
      }
    };

    void init();

    // 10-second polling fallback in case Realtime misses an event.
    const pollInterval = setInterval(() => void checkNonce(), 10_000);

    return () => {
      isActive = false;
      clearInterval(pollInterval);
      if (expireTimeout) clearTimeout(expireTimeout);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userEmail]);

  if (isLocked) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm bg-black/20">
        <div className="rounded-[1.5rem] border border-white/60 bg-white/70 px-8 py-10 shadow-[0_20px_60px_-35px_rgba(15,23,42,0.5)] backdrop-blur text-center max-w-md w-full mx-4">
          <div className="flex justify-center">
            <div className="rounded-full bg-rose-100 p-3">
              <svg className="h-6 w-6 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
          </div>
          <h2 className="text-xl font-semibold text-slate-950 mt-3">Session taken over</h2>
          <p className="text-sm text-slate-600 mt-2 leading-6">
            This dashboard is now active in another window or device. Refresh this page to take over, or sign out.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 mt-6 justify-center">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 transition"
            >
              Refresh to take over
            </button>
            <button
              type="button"
              onClick={() => {
                const supabase = getBrowserSupabaseClient();
                void supabase.auth.signOut().then(() => {
                  window.location.href = "/login";
                });
              }}
              className="rounded-xl border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 transition"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
