import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

// Service-role key — bypasses RLS. Only ever import this from server-side write paths
// (the /api/dev/* routes, the /api/discord/* bot routes) — never from a page/component.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}
