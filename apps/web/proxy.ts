import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Runs before every page: refreshes the Supabase session cookie and sends
 * signed-out visitors to /login, except on the public website pages. Pages still check the user themselves
 * (requireUser); this is not the security boundary, RLS is.
 */
// /api/cron: no user session; each cron route checks CRON_SECRET itself.
const PUBLIC_PREFIXES = ["/login", "/auth/callback", "/privacy", "/terms", "/api/cron"];

/** The company website (home, privacy, terms) and the sign-in pages are public. */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return response; // misconfigured: pages will report the missing variables

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });

  let signedIn = false;
  try {
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  } catch {
    signedIn = false;
  }

  if (!signedIn && !isPublicPath(request.nextUrl.pathname)) {
    const login = new URL("/login", request.url);
    const path = request.nextUrl.pathname + request.nextUrl.search;
    if (path !== "/" && path.length <= 300) login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js)$).*)"],
};
