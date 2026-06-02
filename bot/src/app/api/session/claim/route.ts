import { createClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { getServerSupabaseClient } from "@/lib/supabase-server";

export async function POST(request: NextRequest) {
  const supabase = await getServerSupabaseClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user || !user.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await request.json();

  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }

  const adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { error } = await adminClient
    .from("allowed_emails")
    .update({ session_nonce: sessionId })
    .eq("email", user.email.toLowerCase());

  if (error) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
