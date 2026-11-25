const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");
const { deriveLeadQualityAndPrice } = require("./lead-qualification.service");
const { trackMetricEvent } = require("./metrics.service");

// How long two identical submissions are treated as the same inquiry rather
// than two. Candy's own test on 22 Nov produced two identical rows a minute
// apart, which is the case this guards.
const DUPLICATE_WINDOW_MINUTES = 30;

/**
 * A second submission of the same request, rather than a genuine second
 * inquiry. Matches on the person and what they asked for, within a window.
 *
 * Deliberately NOT matched on email alone: a customer may legitimately submit
 * two different requests (an electrician this week, an accountant next
 * month), and collapsing those would lose a real lead.
 */
async function findRecentDuplicateLead(leadData) {
  const email = String(leadData.workEmail || "").trim().toLowerCase();
  if (!email) return null;

  const supabase = requireSupabase();
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60 * 1000).toISOString();
  const category = leadData.selectedCategory || leadData.highestRiskCategory || null;

  let query = supabase
    .from("lead_submissions")
    .select("*")
    .eq("work_email", email)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);

  // A null category must match other nulls, which .eq() cannot express.
  query = category ? query.eq("selected_category", category) : query.is("selected_category", null);

  const { data, error } = await query.maybeSingle();
  if (error) {
    // Never block a submission because the duplicate check itself failed —
    // a lost lead is worse than a duplicated one.
    console.warn("[lead] duplicate check failed, continuing:", error.message);
    return null;
  }
  return data || null;
}

async function createLeadSubmission(leadData) {
  const supabase = requireSupabase();

  if (leadData.assessmentId) {
    const existing = await findLeadByAssessmentId(leadData.assessmentId);
    if (existing) {
      return existing;
    }
  }

  // The assessment_id guard above only catches a replay of the same
  // assessment. It misses the common case: the quiz posting twice, or a
  // customer pressing submit again, each time with a fresh assessment_id.
  const duplicate = await findRecentDuplicateLead(leadData);
  if (duplicate) {
    console.info(
      `[lead] duplicate submission within ${DUPLICATE_WINDOW_MINUTES}m for ${duplicate.work_email} — returning lead ${duplicate.id}`,
    );
    await trackMetricEvent("duplicate_lead_suppressed", {
      lead_id: duplicate.id,
      category: duplicate.selected_category,
    });
    return duplicate;
  }

  const qualification = deriveLeadQualityAndPrice(leadData);

  const payload = {
    full_name: leadData.fullName,
    work_email: leadData.workEmail,
    phone_number: leadData.phoneNumber || null,
    audience_segment: leadData.audienceSegment || null,
    company_name: leadData.companyName || null,
    role: leadData.role || null,
    business_type: leadData.businessType || null,
    location: leadData.location,
    location_scope: leadData.locationScope || null,
    island: leadData.island || null,
    website: leadData.website || null,
    team_size: leadData.teamSize || null,
    budget_preference: leadData.budgetPreference || null,
    urgency_preference: leadData.urgencyPreference || null,
    prior_consulting_experience: leadData.priorConsultingExperience || null,
    lead_tier: leadData.leadTier || "standard",
    assessment_id: leadData.assessmentId || null,
    normalized_score: leadData.normalizedScore ?? null,
    highest_risk_category: leadData.highestRiskCategory || null,
    selected_category: leadData.selectedCategory || leadData.highestRiskCategory || null,
    primary_issue: leadData.primaryIssue || leadData.highestRiskCategory || null,
    preferred_support_type: leadData.preferredSupportType || null,
    intent_type: qualification.intentType,
    lead_quality_tag: qualification.leadQualityTag,
    lead_price_usd: qualification.leadPriceUsd,
    pricing_band: qualification.pricingBand,
    source: leadData.source || "web",
    metadata: leadData.metadata || {},
  };

  const { data, error } = await supabase
    .from("lead_submissions")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw new AppError("Failed to create lead submission.", 500, error.message);
  }

  await trackMetricEvent("quiz_completion_rate", {
    lead_id: data.id,
    selected_category: payload.selected_category,
    lead_quality_tag: payload.lead_quality_tag,
  });

  return {
    ...data,
    lead_quality_tag: data.lead_quality_tag ?? qualification.leadQualityTag,
    lead_price_usd: data.lead_price_usd ?? qualification.leadPriceUsd,
    intent_type: data.intent_type ?? qualification.intentType,
    pricing_band: data.pricing_band ?? qualification.pricingBand,
  };
}

async function findLeadByAssessmentId(assessmentId) {
  if (!assessmentId) return null;
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("lead_submissions")
    .select("*")
    .eq("assessment_id", assessmentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new AppError("Failed to query lead by assessment.", 500, error.message);
  }
  return data;
}

module.exports = {
  findRecentDuplicateLead,
  createLeadSubmission,
  findLeadByAssessmentId,
};
