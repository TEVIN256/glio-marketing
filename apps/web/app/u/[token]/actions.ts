"use server";

import { redirect } from "next/navigation";
import { isShareToken, resubscribe, unsubscribe } from "@glio/reports";
import { serverDb } from "@/lib/server-db";

/** The link itself is the permission: whoever got the email can stop (or restart) it. */
export async function unsubscribeAction(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  if (!isShareToken(token)) redirect("/");
  await unsubscribe(serverDb(), token, "page");
  redirect(`/u/${token}?done=unsub`);
}

export async function resubscribeAction(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  if (!isShareToken(token)) redirect("/");
  await resubscribe(serverDb(), token);
  redirect(`/u/${token}?done=resub`);
}
