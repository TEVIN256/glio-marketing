import { type NextRequest, NextResponse } from "next/server";
import { NEXT_COOKIE, safeNext } from "@/lib/safe-next";
import { supabaseAsUser } from "@/lib/supabase/server";

/** Email confirmation link lands here: exchange the code for a session. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const supabase = await supabaseAsUser();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const res = NextResponse.redirect(new URL(safeNext(request.cookies.get(NEXT_COOKIE)?.value), request.url));
      res.cookies.set(NEXT_COOKIE, "", { path: "/auth", maxAge: 0 });
      return res;
    }
  }
  return NextResponse.redirect(new URL("/login?e=auth", request.url));
}
