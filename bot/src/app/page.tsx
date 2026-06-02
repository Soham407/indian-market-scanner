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
