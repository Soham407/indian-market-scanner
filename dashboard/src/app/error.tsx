"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard render error", error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#070907] p-6 text-stone-100">
      <div className="w-full max-w-md rounded-lg border border-stone-800 bg-[#0d120d] p-6 shadow-2xl">
        <h1 className="text-lg font-semibold text-stone-50">
          Market Sniper hit an error
        </h1>
        <p className="mt-2 text-sm text-stone-400">
          The dashboard caught a render error and stopped. Your trades and alerts
          in Supabase are unaffected. You can try recovering without losing your
          session.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-stone-500">
            Reference: {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-md bg-lime-300 text-sm font-semibold text-[#10140f] transition hover:bg-lime-200"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
