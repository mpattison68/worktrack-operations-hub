import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Portable Supabase browser client.
 * Works identically against self-hosted Docker Compose Supabase (Linux VM)
 * or an independently controlled external Supabase project.
 *
 * Never place SUPABASE_SERVICE_ROLE_KEY in VITE_* environment variables.
 */
const supabaseUrl = (import.meta.env["VITE_SUPABASE_URL"] as string | undefined)?.trim() ?? "";
const supabaseAnonKey =
  (
    (import.meta.env["VITE_SUPABASE_ANON_KEY"] as string | undefined) ??
    (import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string | undefined)
  )?.trim() ?? "";

let activeDataEpoch: number | null = null;
export function setClientDataEpoch(epoch: number | null): void { activeDataEpoch = epoch; }

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      global: { fetch: (input, init) => {
        const headers=new Headers(init?.headers);
        if(activeDataEpoch !== null) headers.set('x-worktrack-epoch',String(activeDataEpoch));
        return fetch(input,{...init,headers});
      }},
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;