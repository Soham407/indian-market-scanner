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

  // Overwrite session_nonce — triggers Realtime UPDATE on any other active session,
  // which causes that device's SessionGuard to sign out immediately.
  const nonce = crypto.randomUUID();
  await adminClient
    .from("allowed_emails")
    .update({ session_nonce: nonce, session_started_at: new Date().toISOString() })
    .eq("email", email);

  return NextResponse.redirect(origin);
}
