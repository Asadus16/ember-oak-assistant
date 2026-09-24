// Creates (or resets) an admin account for the dashboard and prints the password once.
//   npm run make-admin -- owner@emberandoak.example
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

async function main() {
  const email = z.email().parse(process.argv[2]);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.local).");

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = randomBytes(15).toString("base64url");

  const created = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  let userId = created.data.user?.id;

  if (created.error) {
    // Already exists: find it and reset the password.
    const list = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    userId = list.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id;
    if (!userId) throw new Error(`Could not create or find ${email}: ${created.error.message}`);
    const updated = await supabase.auth.admin.updateUserById(userId, { password });
    if (updated.error) throw new Error(updated.error.message);
  }

  const { error } = await supabase.from("store_admins").upsert({ user_id: userId });
  if (error) throw new Error(`Could not grant admin: ${error.message}`);

  console.log(`Admin ready.\n  email:    ${email}\n  password: ${password}\n(shown once, store it in a password manager)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
