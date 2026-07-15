import { createClient } from "@supabase/supabase-js";

// Server-only client. Uses the Supabase *service role* key, which bypasses
// Row Level Security — this file must never be imported into a client
// component or exposed to the browser. All API routes that use it run on
// the server, which is where NEXT_PUBLIC_-less env vars stay private.
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "sow-uploads";
