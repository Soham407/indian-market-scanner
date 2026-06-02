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
