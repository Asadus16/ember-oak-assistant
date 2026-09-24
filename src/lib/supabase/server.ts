import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Supabase client bound to the visitor's session cookie. It uses the public anon key, so every query is
// governed by RLS as that user. This is the client the admin dashboard uses.
export async function createSessionClient() {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read only. The proxy refreshes the session.
        }
      },
    },
  });
}

// Identity is verified with the Auth server (getUser), never read from the cookie alone.
export async function requireAdmin() {
  const supabase = await createSessionClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { supabase, user: null, isAdmin: false } as const;
  const { data: isAdmin } = await supabase.rpc("am_i_admin");
  return { supabase, user: data.user, isAdmin: isAdmin === true } as const;
}
