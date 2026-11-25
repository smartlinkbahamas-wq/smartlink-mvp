const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("./supabase-guard");

/**
 * Maps a signed-in user to their provider record.
 *
 * expert_user_links is the authoritative 1:1 map (unique on both columns).
 * The same lookup is currently copy-pasted inline in several services; this is
 * the shared form.
 *
 * In utils/ rather than services/ because it is a lookup primitive with no
 * business logic, and supabase-guard.js already sets the precedent for a
 * Supabase-aware util. Putting it in services/ would create import edges
 * between sibling services that currently have none.
 */

/**
 * Lenient: reproduces the existing inline behaviour exactly, including the
 * `|| userId` fallback for seeded providers whose expert_id is their uuid.
 * Existing call sites can adopt this with no behaviour change.
 */
async function resolveExpertId(userId) {
  if (!userId) return null;
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("expert_user_links")
    .select("expert_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data?.expert_id || userId;
}

/** Honest signature for callers that need to know there is no link at all. */
async function findExpertIdLink(userId) {
  if (!userId) return null;
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("expert_user_links")
    .select("expert_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data?.expert_id || null;
}

/**
 * Strict: resolves and then confirms the provider actually exists.
 *
 * Anything that INSERTS a row keyed on expert_id must use this. The lenient
 * fallback above returns a bare user uuid when there is no link, which an
 * unmatched `.eq()` tolerates on a read but a foreign key does not on a
 * write — it would surface as an opaque 500. In the live database only some
 * providers have a link row, so this is a real path, not a theoretical one.
 */
async function requireLinkedExpertId(userId) {
  if (!userId) {
    throw new AppError("Sign in again to continue.", 401, { code: "missing_user" });
  }

  const supabase = requireSupabase();
  const linked = await findExpertIdLink(userId);
  const candidate = linked || userId;

  const { data: expert, error } = await supabase
    .from("experts")
    .select("expert_id")
    .eq("expert_id", candidate)
    .maybeSingle();

  if (error) {
    throw new AppError("Could not load your provider profile.", 500, error.message);
  }
  if (!expert) {
    throw new AppError("No provider profile is linked to this account.", 403, {
      code: "expert_profile_not_linked",
    });
  }

  return expert.expert_id;
}

module.exports = {
  resolveExpertId,
  findExpertIdLink,
  requireLinkedExpertId,
  // Default for feature code: strict, because most of it writes.
  resolveExpertIdForUser: requireLinkedExpertId,
};
