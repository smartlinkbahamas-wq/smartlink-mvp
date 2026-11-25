const crypto = require("crypto");
const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");
const { env } = require("../config/env");

/**
 * Priority 1 — lead trust.
 *
 * Three things providers paying for leads need: the customer proved they own
 * the address, the same request is not counted twice, and a lead that looks
 * fake can be reported to a human.
 */

// ---------------------------------------------------------------------------
// Customer email verification
// ---------------------------------------------------------------------------

const VERIFICATION_TTL_MINUTES = 15;
const VERIFICATION_MAX_ATTEMPTS = 5;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function sixDigitCode() {
  // randomInt is uniform; Math.random()*900000 is not, and this value is the
  // only thing standing between a stranger and someone else's address.
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function hashCode(email, code) {
  // Salted with the email so a stolen hash cannot be replayed against a
  // different address, and keyed with a server secret so the table alone is
  // not enough to verify anything.
  const secret = env.APP_ENCRYPTION_SECRET || env.REVIEW_TOKEN_SECRET || "smartlink-default-secret";
  return crypto.createHmac("sha256", secret).update(`${normalizeEmail(email)}:${code}`).digest("hex");
}

/**
 * Issue a code. Returns the code so the caller can mail it; it is never
 * returned to the browser.
 */
async function startEmailVerification(email, requestIp = null) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) {
    throw new AppError("Enter a valid email address.", 400, { code: "invalid_email" });
  }

  const supabase = requireSupabase();
  const code = sixDigitCode();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MINUTES * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("customer_email_verifications")
    .insert({
      email: normalized,
      code_hash: hashCode(normalized, code),
      expires_at: expiresAt,
      max_attempts: VERIFICATION_MAX_ATTEMPTS,
      request_ip: requestIp,
    })
    .select("id, expires_at")
    .single();

  if (error) {
    if (error.code === "42P01" || /schema cache/i.test(error.message || "")) {
      throw new AppError(
        "Email verification is not set up yet. Run sql/install_lead_trust.sql.",
        503,
        { code: "verification_not_configured" },
      );
    }
    throw new AppError("Could not start email verification.", 500, error.message);
  }

  return { verificationId: data.id, expiresAt: data.expires_at, code, expiresMinutes: VERIFICATION_TTL_MINUTES };
}

/**
 * Check a code against the newest live challenge for that address.
 *
 * Attempts are counted even on failure, so a wrong code cannot be brute
 * forced within the window.
 */
async function confirmEmailVerification(email, code) {
  const normalized = normalizeEmail(email);
  const supplied = String(code || "").trim();
  if (!normalized || !supplied) {
    throw new AppError("Enter the code we emailed you.", 400, { code: "verification_code_required" });
  }

  const supabase = requireSupabase();
  const { data: challenge, error } = await supabase
    .from("customer_email_verifications")
    .select("id, code_hash, expires_at, consumed_at, attempts, max_attempts")
    .eq("email", normalized)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (error.code === "42P01" || /schema cache/i.test(error.message || "")) {
      throw new AppError(
        "Email verification is not set up yet. Run sql/install_lead_trust.sql.",
        503,
        { code: "verification_not_configured" },
      );
    }
    throw new AppError("Could not check that code.", 500, error.message);
  }

  if (!challenge) {
    throw new AppError("Request a new code and try again.", 400, { code: "verification_not_found" });
  }
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    throw new AppError("That code has expired. Request a new one.", 400, { code: "verification_expired" });
  }
  if (challenge.attempts >= challenge.max_attempts) {
    throw new AppError("Too many incorrect attempts. Request a new code.", 429, {
      code: "verification_attempts_exhausted",
    });
  }

  const expected = hashCode(normalized, supplied);
  // Constant-time compare, so a near-miss cannot be distinguished by timing.
  const matches =
    expected.length === challenge.code_hash.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(challenge.code_hash));

  if (!matches) {
    await supabase
      .from("customer_email_verifications")
      .update({ attempts: challenge.attempts + 1 })
      .eq("id", challenge.id);
    const remaining = Math.max(0, challenge.max_attempts - (challenge.attempts + 1));
    throw new AppError(
      remaining > 0 ? `That code is not right. ${remaining} attempt(s) left.` : "That code is not right.",
      400,
      { code: "verification_code_invalid", attemptsRemaining: remaining },
    );
  }

  await supabase
    .from("customer_email_verifications")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", challenge.id);

  return { verified: true, email: normalized };
}

/**
 * Has this address been verified recently enough to accept a request?
 *
 * Returns true/false rather than throwing, so the lead path can decide
 * whether to require it.
 */
async function isEmailVerified(email, withinMinutes = 120) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  try {
    const supabase = requireSupabase();
    const since = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("customer_email_verifications")
      .select("id")
      .eq("email", normalized)
      .not("consumed_at", "is", null)
      .gte("consumed_at", since)
      .limit(1)
      .maybeSingle();

    if (error) return false;
    return Boolean(data);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Suspicious lead reporting
// ---------------------------------------------------------------------------

const SUSPICIOUS_REASONS = [
  "fake_customer",
  "payment_scam",
  "repeated_abusive",
  "harassment",
  "other",
];

/**
 * A provider flags an opportunity as not genuine.
 *
 * Scoped by expert_id so one provider cannot report another's opportunity,
 * and upserted so re-reporting updates rather than stacking duplicates in the
 * administrator's queue.
 */
async function reportSuspiciousLead({ expertId, introductionRequestId, reason, notes, reportedByUserId }) {
  if (!SUSPICIOUS_REASONS.includes(reason)) {
    throw new AppError("Choose a reason for the report.", 400, {
      code: "invalid_report_reason",
      allowed: SUSPICIOUS_REASONS,
    });
  }

  const supabase = requireSupabase();

  // Ownership: the opportunity must be this provider's.
  const { data: opportunity, error: lookupError } = await supabase
    .from("introduction_requests")
    .select("id, lead_id")
    .eq("id", introductionRequestId)
    .eq("expert_id", expertId)
    .maybeSingle();

  if (lookupError) {
    throw new AppError("Could not load that opportunity.", 500, lookupError.message);
  }
  // 404 rather than 403: another provider's opportunity must not be
  // distinguishable from one that does not exist.
  if (!opportunity) {
    throw new AppError("Opportunity not found.", 404, { code: "opportunity_not_found" });
  }

  const { data, error } = await supabase
    .from("suspicious_lead_reports")
    .upsert(
      {
        introduction_request_id: introductionRequestId,
        lead_id: opportunity.lead_id,
        expert_id: expertId,
        reported_by_user_id: reportedByUserId || null,
        reason,
        notes: notes || null,
        status: "new",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "expert_id,introduction_request_id" },
    )
    .select("id, status, created_at")
    .single();

  if (error) {
    if (error.code === "42P01" || /schema cache/i.test(error.message || "")) {
      throw new AppError(
        "Suspicious lead reporting is not set up yet. Run sql/install_lead_trust.sql.",
        503,
        { code: "reports_not_configured" },
      );
    }
    throw new AppError("Could not submit that report.", 500, error.message);
  }

  return data;
}

/** The administrator's review queue. */
async function listSuspiciousLeadReports({ status = null, limit = 100 } = {}) {
  try {
    const supabase = requireSupabase();
    let query = supabase
      .from("suspicious_lead_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) {
      if (error.code === "42P01" || /schema cache/i.test(error.message || "")) return [];
      throw new AppError("Could not load suspicious lead reports.", 500, error.message);
    }
    return data || [];
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Could not load suspicious lead reports.", 500, error.message);
  }
}

/** An administrator records what they decided. */
async function reviewSuspiciousLeadReport({ reportId, status, reviewOutcome, reviewNotes, reviewedByUserId }) {
  const allowed = ["new", "under_review", "actioned", "dismissed"];
  if (!allowed.includes(status)) {
    throw new AppError("Invalid report status.", 400, { code: "invalid_report_status", allowed });
  }

  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("suspicious_lead_reports")
    .update({
      status,
      review_outcome: reviewOutcome || null,
      review_notes: reviewNotes || null,
      reviewed_by_user_id: reviewedByUserId || null,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", reportId)
    .select("*")
    .single();

  if (error) throw new AppError("Could not update that report.", 500, error.message);
  return data;
}

/**
 * Opportunities this provider has reported.
 *
 * Used so a declined-as-suspicious opportunity is excluded from the
 * provider's acceptance measures — Candy's requirement that providers are not
 * penalised for declining suspicious leads. Returning the ids keeps that a
 * scoring rule rather than a note in the interface.
 */
async function listReportedOpportunityIds(expertId) {
  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase
      .from("suspicious_lead_reports")
      .select("introduction_request_id")
      .eq("expert_id", expertId);

    if (error) return [];
    return (data || []).map((row) => row.introduction_request_id).filter(Boolean);
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

const LEAD_ALERT_MODES = ["immediate", "daily_summary", "off"];

async function getNotificationPreferences(expertId) {
  const fallback = { expert_id: expertId, lead_alerts: "immediate", available: false };
  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase
      .from("notification_preferences")
      .select("*")
      .eq("expert_id", expertId)
      .maybeSingle();

    if (error) {
      if (error.code === "42P01" || /schema cache/i.test(error.message || "")) return fallback;
      console.error("[lead-trust] failed to read notification preferences:", error.message);
      return fallback;
    }
    // No row yet means the default, which is immediate.
    return data ? { ...data, available: true } : { ...fallback, available: true };
  } catch (_) {
    return fallback;
  }
}

async function setLeadAlertMode(expertId, mode) {
  if (!LEAD_ALERT_MODES.includes(mode)) {
    throw new AppError("Choose immediate, daily summary, or off.", 400, {
      code: "invalid_lead_alert_mode",
      allowed: LEAD_ALERT_MODES,
    });
  }

  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("notification_preferences")
    .upsert(
      { expert_id: expertId, lead_alerts: mode, updated_at: new Date().toISOString() },
      { onConflict: "expert_id" },
    )
    .select("*")
    .single();

  if (error) {
    if (error.code === "42P01" || /schema cache/i.test(error.message || "")) {
      throw new AppError(
        "Notification settings are not set up yet. Run sql/install_lead_trust.sql.",
        503,
        { code: "preferences_not_configured" },
      );
    }
    throw new AppError("Could not save that setting.", 500, error.message);
  }

  return data;
}

module.exports = {
  SUSPICIOUS_REASONS,
  LEAD_ALERT_MODES,
  startEmailVerification,
  confirmEmailVerification,
  isEmailVerified,
  reportSuspiciousLead,
  listSuspiciousLeadReports,
  reviewSuspiciousLeadReport,
  listReportedOpportunityIds,
  getNotificationPreferences,
  setLeadAlertMode,
};
