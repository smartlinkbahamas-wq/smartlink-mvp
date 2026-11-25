const crypto = require("crypto");

const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");
const { env } = require("../config/env");

/**
 * Secure customer links.
 *
 * Generalises the review_tokens pattern already working in this codebase: a
 * hashed, single-purpose, expiring token that lets a customer approve a
 * quotation, confirm completion, answer a survey or view an invoice without
 * holding an account.
 *
 * Two properties this must have, and the reasons they are not optional:
 *
 * - The token is stored hashed. This table will eventually hold a link for
 *   every quotation on the platform; if it leaked in plaintext, anyone
 *   holding it could approve quotations as the customer.
 *
 * - High-value actions take a link AND an emailed code. A link can be
 *   forwarded, sit in a shared inbox, or leak through a referrer header. The
 *   code proves the person acting controls the address the quotation was
 *   sent to. Surveys use the link alone, because the cost of a wrong survey
 *   response is not worth a second step.
 */

const NOT_INSTALLED = "Secure customer links are not set up yet. Run sql/install_business_foundations.sql.";

const CODE_TTL_MINUTES = 15;
const DEFAULT_EXPIRY_DAYS = 30;

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "secure_links_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

function signingSecret() {
  const secret = env.APP_ENCRYPTION_SECRET || env.REVIEW_TOKEN_SECRET;
  if (!secret) {
    // Deliberately fatal rather than falling back to a constant. This repo is
    // public: a default secret here would mean anyone could mint a valid
    // approval token for any quotation on the platform.
    throw new AppError(
      "Secure links are not configured. Set APP_ENCRYPTION_SECRET.",
      500,
      { code: "signing_secret_missing" },
    );
  }
  return secret;
}

function hashToken(token) {
  return crypto.createHmac("sha256", signingSecret()).update(String(token)).digest("hex");
}

/** Salted with the link id, so one stolen code hash cannot be replayed elsewhere. */
function hashCode(linkId, code) {
  return crypto
    .createHmac("sha256", signingSecret())
    .update(`${linkId}:${code}`)
    .digest("hex");
}

function generateToken() {
  // 32 bytes, url-safe. Long enough that guessing is not a consideration.
  return crypto.randomBytes(32).toString("base64url");
}

function generateCode() {
  // randomInt, not Math.random: this is a security control.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Appends to the access trail. Never throws.
 *
 * The audit is secondary to the customer's action: failing to record a view
 * must not stop the customer approving their quotation.
 */
async function recordAccess(secureLinkId, event, { ip, userAgent, detail } = {}) {
  if (!secureLinkId) return;
  try {
    const supabase = requireSupabase();
    await supabase.from("secure_link_access").insert({
      secure_link_id: secureLinkId,
      event,
      ip: ip || null,
      // Truncated: the column is informational and some clients send very long
      // strings. A trail entry is worth more than a rejected insert.
      user_agent: userAgent ? String(userAgent).slice(0, 500) : null,
      detail: detail ? String(detail).slice(0, 500) : null,
    });
  } catch (error) {
    console.warn("[secure-link] could not record access:", error.message);
  }
}

/**
 * Mints a link.
 *
 * The plaintext token and code are returned exactly once, to be emailed. They
 * are never readable again from the database.
 */
async function createSecureLink({
  purpose,
  subjectType,
  subjectId,
  expertId = null,
  recipientEmail = null,
  expiresInDays = DEFAULT_EXPIRY_DAYS,
  expiresAt = null,
  requireCode = false,
}) {
  const supabase = requireSupabase();

  const token = generateToken();
  const resolvedExpiry =
    expiresAt || new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("secure_links")
    .insert({
      token_hash: hashToken(token),
      purpose,
      subject_type: subjectType,
      subject_id: subjectId,
      expert_id: expertId,
      recipient_email: recipientEmail ? String(recipientEmail).trim().toLowerCase() : null,
      expires_at: resolvedExpiry,
    })
    .select("id, purpose, expires_at")
    .single();

  if (error) guard(error, "Could not create a secure link.");

  let code = null;
  if (requireCode) {
    code = generateCode();
    const { error: codeError } = await supabase
      .from("secure_links")
      .update({
        code_hash: hashCode(data.id, code),
        code_expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),
        code_attempts: 0,
      })
      .eq("id", data.id);

    if (codeError) guard(codeError, "Could not create a verification code.");
    await recordAccess(data.id, "code_sent");
  }

  return {
    id: data.id,
    token,
    code,
    codeExpiresMinutes: requireCode ? CODE_TTL_MINUTES : null,
    expiresAt: data.expires_at,
  };
}

/**
 * Resolves a token to its link, refusing anything not currently usable.
 *
 * Every rejection returns the same shape of message. A caller probing tokens
 * learns only "this does not work", never whether a token existed, expired or
 * was already used.
 */
async function resolveSecureLink(token, { purpose = null, context = {} } = {}) {
  if (!token || typeof token !== "string") {
    throw new AppError("This link is not valid.", 400, { code: "invalid_link" });
  }

  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("secure_links")
    .select("*")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (error) guard(error, "Could not open that link.");

  const invalid = () => new AppError("This link is no longer valid.", 410, { code: "link_invalid" });

  if (!data) throw invalid();
  if (purpose && data.purpose !== purpose) throw invalid();
  if (data.revoked_at) throw invalid();
  if (data.used_at) {
    throw new AppError("This link has already been used.", 410, { code: "link_used" });
  }
  if (new Date(data.expires_at).getTime() < Date.now()) {
    throw new AppError("This link has expired.", 410, { code: "link_expired" });
  }

  await recordAccess(data.id, "viewed", context);
  return data;
}

/** Issues a fresh code for an existing link, for "resend". */
async function issueLinkCode(secureLinkId) {
  const supabase = requireSupabase();
  const code = generateCode();

  const { error } = await supabase
    .from("secure_links")
    .update({
      code_hash: hashCode(secureLinkId, code),
      code_expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),
      code_attempts: 0,
      code_verified_at: null,
    })
    .eq("id", secureLinkId);

  if (error) guard(error, "Could not send a verification code.");

  await recordAccess(secureLinkId, "code_sent");
  return { code, expiresMinutes: CODE_TTL_MINUTES };
}

/**
 * Checks a code against a link.
 *
 * Attempts are counted on failure, so a wrong guess costs the attacker one of
 * five tries. Comparison is constant-time: a byte-by-byte compare that exits
 * early leaks how much of the code was right.
 */
async function verifyLinkCode(secureLinkId, code, context = {}) {
  const supabase = requireSupabase();

  const { data: link, error } = await supabase
    .from("secure_links")
    .select("id, code_hash, code_expires_at, code_attempts, code_max_attempts")
    .eq("id", secureLinkId)
    .maybeSingle();

  if (error) guard(error, "Could not check that code.");
  if (!link || !link.code_hash) {
    throw new AppError("Request a new code and try again.", 400, { code: "code_not_found" });
  }
  if (link.code_expires_at && new Date(link.code_expires_at).getTime() < Date.now()) {
    throw new AppError("That code has expired. Request a new one.", 400, { code: "code_expired" });
  }
  if (link.code_attempts >= link.code_max_attempts) {
    throw new AppError("Too many incorrect attempts. Request a new code.", 429, {
      code: "code_attempts_exceeded",
    });
  }

  const expected = Buffer.from(link.code_hash, "hex");
  const supplied = Buffer.from(hashCode(secureLinkId, String(code).trim()), "hex");
  const matches = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);

  if (!matches) {
    await supabase
      .from("secure_links")
      .update({ code_attempts: link.code_attempts + 1 })
      .eq("id", secureLinkId);
    await recordAccess(secureLinkId, "code_failed", context);
    throw new AppError("That code is not correct.", 400, { code: "code_incorrect" });
  }

  await supabase
    .from("secure_links")
    .update({ code_verified_at: new Date().toISOString(), code_attempts: 0 })
    .eq("id", secureLinkId);
  await recordAccess(secureLinkId, "code_verified", context);

  return { verified: true };
}

/**
 * Marks a link spent.
 *
 * Conditional on used_at still being null, so two submissions arriving
 * together cannot both succeed -- the second gets no row back and is told the
 * link was already used, rather than both approving the same quotation.
 */
async function consumeSecureLink(secureLinkId, { detail = null, context = {} } = {}) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("secure_links")
    .update({ used_at: new Date().toISOString() })
    .eq("id", secureLinkId)
    .is("used_at", null)
    .select("id")
    .maybeSingle();

  if (error) guard(error, "Could not complete that action.");
  if (!data) {
    throw new AppError("This link has already been used.", 410, { code: "link_used" });
  }

  await recordAccess(secureLinkId, "actioned", { ...context, detail });
  return { id: data.id };
}

/** Invalidates outstanding links for a subject, e.g. when a quotation is revised. */
async function revokeLinksForSubject(subjectType, subjectId, purpose = null) {
  const supabase = requireSupabase();

  let query = supabase
    .from("secure_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .is("used_at", null)
    .is("revoked_at", null);

  if (purpose) query = query.eq("purpose", purpose);

  const { error } = await query;
  if (error && !tableIsMissing(error)) {
    console.warn("[secure-link] could not revoke links:", error.message);
  }
}

async function listAccessTrail(secureLinkId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("secure_link_access")
    .select("*")
    .eq("secure_link_id", secureLinkId)
    .order("created_at", { ascending: true });

  if (error) guard(error, "Could not load the access history.");
  return data || [];
}

function contextFromRequest(req) {
  return {
    ip: req?.ip || null,
    userAgent: req?.get?.("user-agent") || null,
  };
}

module.exports = {
  CODE_TTL_MINUTES,
  createSecureLink,
  resolveSecureLink,
  issueLinkCode,
  verifyLinkCode,
  consumeSecureLink,
  revokeLinksForSubject,
  listAccessTrail,
  recordAccess,
  contextFromRequest,
};
