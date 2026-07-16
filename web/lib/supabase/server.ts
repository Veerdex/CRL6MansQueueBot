import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

// Anon key, RLS-bound — safe for anything reading on behalf of an anonymous site visitor.
export function createServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  return createClient<Database>(url, anonKey, {
    auth: { persistSession: false },
  });
}
