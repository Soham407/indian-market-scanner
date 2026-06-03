"use client";

import { useEffect, useRef, useState } from "react";
import { getBrowserSupabaseClient } from "@/lib/supabase-browser";

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

    const checkNonce = async () => {
      const { data } = await supabase
        .from("allowed_emails")
        .select("session_nonce")
        .eq("email", userEmail)
        .maybeSingle();
      if (isActive && data?.session_nonce && data.session_nonce !== mySessionId) {
        setIsLocked(true);
      }
    };

    // No server-side filter: the @ in email addresses breaks Supabase Realtime's
    // filter parser. Email equality is checked client-side in the callback instead.
    const channel = supabase
      .channel(`session-guard-${mySessionId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "allowed_emails" },
        (payload) => {
          const row = payload.new as { email?: string; session_nonce?: string | null };
          if (row.email === userEmail && row.session_nonce && row.session_nonce !== mySessionId) {
            setIsLocked(true);
          }
        },
      )
      .subscribe();

    // Claim this tab's session, then immediately verify the DB reflects our nonce.
    // The verify step catches the race where another device claimed between subscribe and claim.
    const claimAndVerify = async () => {
      await fetch("/api/session/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: mySessionId }),
      });
      await checkNonce();
    };
    void claimAndVerify();

    // 30-second polling fallback in case Realtime misses an event.
    const pollInterval = setInterval(() => void checkNonce(), 30_000);

    return () => {
      isActive = false;
      clearInterval(pollInterval);
      void supabase.removeChannel(channel);
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
