import { type NextRequest, NextResponse } from "next/server";
import { isShareToken, unsubscribe } from "@glio/reports";
import { serverDb } from "@/lib/server-db";

/**
 * One-click unsubscribe (RFC 8058): mail apps (Gmail, Apple Mail, Outlook)
 * POST here from the List-Unsubscribe header, without opening a page.
 * A GET (someone opening the address) goes to the page with a button instead.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const done = isShareToken(token) ? await unsubscribe(serverDb(), token, "one-click") : null;
  if (!done) return new NextResponse("Not found", { status: 404 });
  console.log(JSON.stringify({ event: "report_unsubscribed", via: "one-click" }));
  return new NextResponse("Unsubscribed", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return NextResponse.redirect(new URL(isShareToken(token) ? `/u/${token}` : "/", request.url), 303);
}
