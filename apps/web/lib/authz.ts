import { requireUser } from "./supabase/server";

export type Role = "owner" | "manager" | "analyst" | "client_viewer";

/**
 * The caller's role in a workspace and whether they can see a client, both
 * answered by the database under the user's own permissions (RLS). Server
 * actions call this BEFORE using the server-privileged connection.
 */
export async function clientAccess(workspaceId: string, clientId: string) {
  const { supabase, user } = await requireUser();
  const [{ data: membership }, { data: client }] = await Promise.all([
    supabase.from("memberships").select("role, client_id").eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle(),
    supabase.from("clients").select("id, name, workspace_id").eq("id", clientId).eq("workspace_id", workspaceId).maybeSingle(),
  ]);
  const role = (membership?.role ?? null) as Role | null;
  return {
    supabase,
    user,
    role,
    client: client as { id: string; name: string; workspace_id: string } | null,
    canView: Boolean(client && role),
    canGenerate: Boolean(client && role && role !== "client_viewer"),
    canManage: Boolean(client && (role === "owner" || role === "manager")),
  };
}
