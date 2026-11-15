/**
 * Create (or promote) a super admin.
 *
 *   node scripts/create-superadmin.js <email> <password> ["Full Name"]
 *
 * Idempotent: an existing auth user is reused and its password reset, so this
 * is also the way to promote someone who already signed up.
 */
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const [, , emailArg, passwordArg, nameArg] = process.argv;

if (!emailArg || !passwordArg) {
  console.error("Usage: node scripts/create-superadmin.js <email> <password> [\"Full Name\"]");
  process.exit(1);
}

// Mirrors createAdminUserSchema in src/validators/admin-rbac.validator.js so a
// seeded account can still change its own password through the admin UI.
const policy = [
  [passwordArg.length >= 12, "at least 12 characters"],
  [/[A-Z]/.test(passwordArg), "an uppercase letter"],
  [/[a-z]/.test(passwordArg), "a lowercase letter"],
  [/\d/.test(passwordArg), "a number"],
].filter(([ok]) => !ok);

if (policy.length) {
  console.error(`Password must contain ${policy.map(([, text]) => text).join(", ")}.`);
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

const email = emailArg.trim().toLowerCase();
const fullName = nameArg || "Super Admin";
const ROLE = "super_admin";

async function findAuthUserByEmail(target) {
  const perPage = 500;
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    const match = users.find((item) => item?.email?.trim()?.toLowerCase() === target);
    if (match) return match;
    if (users.length < perPage) break;
  }
  return null;
}

async function run() {
  console.log(`Granting ${ROLE} to ${email}...`);

  const existing = await findAuthUserByEmail(email);
  let userId;

  const attributes = {
    password: passwordArg,
    email_confirm: true,
    user_metadata: { full_name: fullName, app_role: ROLE },
  };

  if (existing) {
    userId = existing.id;
    const { error } = await supabase.auth.admin.updateUserById(userId, attributes);
    if (error) throw new Error(`Could not update the auth user: ${error.message}`);
    console.log(`  auth user     reused (${userId}), password reset`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({ email, ...attributes });
    if (error) throw new Error(`Could not create the auth user: ${error.message}`);
    userId = data.user.id;
    console.log(`  auth user     created (${userId})`);
  }

  const { error: profileError } = await supabase.from("user_profiles").upsert(
    {
      user_id: userId,
      email,
      role: ROLE,
      full_name: fullName,
      status: "active",
      email_verified: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (profileError) throw new Error(`Could not upsert user_profiles: ${profileError.message}`);
  console.log("  user_profiles upserted");

  // The admin UI reads permissions from admin_user_roles, not from the profile
  // role, so both have to be written or the account signs in with no access.
  const { error: roleError } = await supabase.from("admin_user_roles").upsert(
    { user_id: userId, role: ROLE, is_active: true, updated_at: new Date().toISOString() },
    { onConflict: "user_id,role" },
  );
  if (roleError) throw new Error(`Could not upsert admin_user_roles: ${roleError.message}`);
  console.log("  admin_user_roles upserted");

  const { error: securityError } = await supabase.from("auth_security_state").upsert(
    {
      user_id: userId,
      failed_count: 0,
      suspicious_score: 0,
      lock_until: null,
      captcha_required_until: null,
      mfa_pending: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (securityError) throw new Error(`Could not upsert auth_security_state: ${securityError.message}`);
  console.log("  auth_security_state reset");

  console.log(`\nDone. ${email} can sign in at /login with full super admin access.`);
}

run().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exit(1);
});
