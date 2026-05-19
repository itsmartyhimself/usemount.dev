import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { supabaseAdmin } from "../supabase/admin.js"

// apps/api runs with the service-role key, which BYPASSES RLS. So every
// authenticated route must (1) prove who the caller is and (2) check that
// caller is allowed to touch the target workspace — in code, here. The DB is
// not the gate; these helpers are.

export interface ApiUser {
  id: string
  email: string | null
}

// Verify the `Authorization: Bearer <supabase access token>` header. The web
// client attaches session.access_token; supabaseAdmin().auth.getUser validates
// the JWT signature/expiry against the project and returns the auth user. The
// returned id equals public.users.id (the signup trigger keys public.users on
// auth.users.id), so it is the join key for every ownership check below.
export async function requireUser(c: Context): Promise<ApiUser> {
  const header = c.req.header("authorization") ?? ""
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : ""
  if (!token) {
    throw new HTTPException(401, { message: "Missing bearer token" })
  }

  const { data, error } = await supabaseAdmin().auth.getUser(token)
  if (error || !data.user) {
    throw new HTTPException(401, { message: "Invalid or expired session" })
  }
  return { id: data.user.id, email: data.user.email ?? null }
}

// Throws 403 unless the user is a member of the workspace.
export async function assertWorkspaceMember(
  workspaceId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await supabaseAdmin()
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error || !data) {
    throw new HTTPException(403, { message: "Not a member of this workspace" })
  }
}

// Throws 403 unless the user is the workspace owner. repo_connections are a
// mutation only owners may make (mirrors the SQL is_workspace_owner RLS policy
// that applies to authenticated clients — apps/api must enforce the same rule
// itself because service-role skips RLS).
export async function assertWorkspaceOwner(
  workspaceId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await supabaseAdmin()
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle()
  if (error || !data) {
    throw new HTTPException(403, { message: "Only the workspace owner can do this" })
  }
}
