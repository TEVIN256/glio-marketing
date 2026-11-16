import { type NextRequest, NextResponse } from "next/server";
import { supabaseAsUser } from "@/lib/supabase/server";

/** Email confirmation link lands here: exchange the code for a session. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const supabase = await supabaseAsUser();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.redirect(new URL("/login?e=auth", request.url));
}
