import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import { env } from "./env.ts";

export type DB = SupabaseClient;

// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は Edge Functions に自動で設定される
export function db(): DB {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

/** supabase-js の結果からエラーを例外にして data を取り出す */
export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export async function getSetting(sb: DB, key: string): Promise<string | null> {
  const row = must(await sb.from("settings").select("value").eq("key", key).maybeSingle()) as
    | { value: string }
    | null;
  return row?.value ?? null;
}
