import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Builds the server-side Supabase client, validating env vars at call time.
 *
 * The check is intentionally lazy: throwing here (rather than at module load)
 * keeps the module import-safe, so `next build` can statically analyze routes
 * that import it without requiring real credentials to be present.
 */
function createSupabaseAdmin(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error('Missing environment variable: SUPABASE_URL');
  }

  if (!supabaseServiceRoleKey) {
    throw new Error('Missing environment variable: SUPABASE_SERVICE_ROLE_KEY');
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

let client: SupabaseClient | undefined;

/** Returns a lazily-instantiated singleton Supabase admin client. */
function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createSupabaseAdmin();
  }
  return client;
}

/**
 * Server-side Supabase client using the service role key.
 *
 * The client is created lazily on first property access, so importing this
 * module never throws and never connects until it is actually used.
 *
 * WARNING: This client bypasses Row Level Security (RLS). Never import it
 * into client/browser code. Use it only in server-side contexts such as
 * Route Handlers, Server Actions, API routes, or other backend functions.
 */
export const supabaseAdmin: SupabaseClient = new Proxy(
  {} as SupabaseClient,
  {
    get(_target, prop, receiver) {
      const value = Reflect.get(getSupabaseAdmin(), prop, receiver);
      return typeof value === 'function'
        ? value.bind(getSupabaseAdmin())
        : value;
    },
  },
);