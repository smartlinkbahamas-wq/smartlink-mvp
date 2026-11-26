const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");

/**
 * The continual improvement register.
 *
 * THE GOVERNING RULE: not every ticket creates an action. The system surfaces
 * candidates and counts how often the same thing recurs; a person decides
 * whether it is worth acting on. A register that opens an entry for every
 * complaint becomes a list nobody reads, which is worse than no register.
 *
 * That is why listCandidates() groups signals and counts recurrence rather
 * than returning raw incidents, and why nothing in this file creates an entry
 * automatically.
 */

const NOT_INSTALLED = "The improvement register is not set up yet. Run sql/install_improvement.sql.";

const SOURCES = [
  "complaint",
  "dispute",
  "unverifiable_job",
  "provider_feedback",
  "customer_feedback",
  "internal_review",
  "other",
];

const STATUSES = ["open", "in_progress", "completed", "cancelled"];

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "improvement_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

async function safeSelect(builder) {
  const { data, error } = await builder;
  if (error) {
    if (tableIsMissing(error)) return [];
    console.warn("[improvement] read failed:", error.message);
    return [];
  }
  return data || [];
}

async function nextReference() {
  const supabase = requireSupabase();
  const { data, error } = await supabase.rpc("next_improvement_number");

  if (error) {
    if (tableIsMissing(error) || /function .* does not exist/i.test(error.message || "")) {
      throw new AppError(NOT_INSTALLED, 503, { code: "improvement_not_installed" });
    }
    throw new AppError("Could not allocate a reference.", 500, error.message);
  }
  return `IMP-${String(data).padStart(4, "0")}`;
}

// --- The register ----------------------------------------------------------

async function listActions({ status = null } = {}) {
  const supabase = requireSupabase();

  let query = supabase
    .from("improvement_actions")
    .select("*")
    .order("identified_on", { ascending: false });

  if (status === "open") query = query.in("status", ["open", "in_progress"]);
  else if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) guard(error, "Could not load the register.");

  const today = new Date().toISOString().slice(0, 10);
  return (data || []).map((action) => ({
    ...action,
    // Overdue is derived, never stored: a stored flag would be wrong from the
    // moment a target date passed until something recalculated it.
    is_overdue:
      ["open", "in_progress"].includes(action.status) &&
      Boolean(action.target_date) &&
      action.target_date < today,
    // An action completed but never reviewed is the most common way a register
    // stops meaning anything, so it is surfaced rather than left to notice.
    awaiting_effectiveness_review:
      action.status === "completed" && !action.effectiveness_reviewed_on,
  }));
}

async function createAction(payload, authorUserId) {
  if (!SOURCES.includes(payload.source)) {
    throw new AppError("Choose where this came from.", 400, { code: "invalid_source" });
  }

  const supabase = requireSupabase();
  const reference = await nextReference();

  const { data, error } = await supabase
    .from("improvement_actions")
    .insert({
      reference,
      source: payload.source,
      source_ticket_id: payload.sourceTicketId || null,
      source_job_id: payload.sourceJobId || null,
      description: String(payload.description).trim(),
      category: payload.category?.trim() || null,
      possible_root_cause: payload.possibleRootCause?.trim() || null,
      corrective_action: payload.correctiveAction?.trim() || null,
      assigned_to_user_id: payload.assignedToUserId || authorUserId || null,
      assigned_to_name: payload.assignedToName?.trim() || null,
      target_date: payload.targetDate || null,
    })
    .select("*")
    .single();

  if (error) guard(error, "Could not add that entry.");
  return data;
}

async function updateAction(actionId, payload) {
  const supabase = requireSupabase();

  const update = { updated_at: new Date().toISOString() };
  const fields = {
    description: "description",
    category: "category",
    possibleRootCause: "possible_root_cause",
    correctiveAction: "corrective_action",
    assignedToName: "assigned_to_name",
    targetDate: "target_date",
    effectivenessReview: "effectiveness_review",
  };

  for (const [key, column] of Object.entries(fields)) {
    if (payload[key] !== undefined) {
      update[column] = typeof payload[key] === "string" ? payload[key].trim() || null : payload[key];
    }
  }

  if (payload.status !== undefined) {
    if (!STATUSES.includes(payload.status)) {
      throw new AppError("That is not a valid status.", 400, { code: "invalid_status" });
    }
    update.status = payload.status;
    // Completion date is set here rather than asked for: the date something
    // was marked done is the date it was marked done.
    if (payload.status === "completed") update.completed_on = new Date().toISOString().slice(0, 10);
  }

  if (payload.wasEffective !== undefined) {
    update.was_effective = payload.wasEffective;
    update.effectiveness_reviewed_on = new Date().toISOString().slice(0, 10);
  }

  const { data, error } = await supabase
    .from("improvement_actions")
    .update(update)
    .eq("id", actionId)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23514") {
      throw new AppError(
        "Record what was actually done before marking this complete, and write the review before giving a verdict on whether it worked.",
        400,
        { code: "incomplete_entry" },
      );
    }
    guard(error, "Could not save that entry.");
  }
  if (!data) {
    throw new AppError("That entry could not be found.", 404, { code: "action_not_found" });
  }
  return data;
}

// --- Candidates ------------------------------------------------------------

/**
 * Patterns worth considering, with how often each has recurred.
 *
 * Grouped, not itemised. One complaint about one job is an incident; the same
 * complaint four times is a candidate for an improvement action, and only the
 * second is worth an administrator's attention here.
 *
 * Nothing is created from this. It is a reading, and a person decides.
 */
async function listCandidates() {
  const supabase = requireSupabase();

  const [tickets, jobs, providerSurveys, suspicious, existing] = await Promise.all([
    safeSelect(
      supabase.from("support_tickets").select("id, category, subject, expert_id, created_at").eq("category", "job_complaint"),
    ),
    safeSelect(supabase.from("jobs").select("id, status, expert_id, job_name")),
    safeSelect(
      supabase.from("provider_followup_surveys").select("request_described_accurately, customer_responsive, opportunity_worthwhile, suggestions"),
    ),
    safeSelect(supabase.from("suspicious_lead_reports").select("id, reason, status")),
    safeSelect(supabase.from("improvement_actions").select("source, source_ticket_id, description, status")),
  ]);

  // Sources already covered by an open entry, so an administrator is not asked
  // twice about the same pattern.
  const coveredSources = new Set(
    existing.filter((a) => ["open", "in_progress"].includes(a.status)).map((a) => a.source),
  );

  const disputed = jobs.filter((j) => j.status === "disputed");
  const unverifiable = jobs.filter((j) => j.status === "unverifiable");

  const inaccurateRequests = providerSurveys.filter((s) => s.request_described_accurately === false);
  const unresponsiveCustomers = providerSurveys.filter((s) => s.customer_responsive === false);
  const notWorthwhile = providerSurveys.filter((s) => s.opportunity_worthwhile === false);

  const suspiciousByReason = {};
  for (const report of suspicious) {
    suspiciousByReason[report.reason] = (suspiciousByReason[report.reason] || 0) + 1;
  }

  const candidates = [
    {
      key: "complaints",
      source: "complaint",
      label: "Customer complaints about completed work",
      occurrences: tickets.length,
      detail: tickets.length
        ? `${tickets.length} complaint(s) raised. Look for a pattern in what customers are reporting.`
        : null,
    },
    {
      key: "disputed",
      source: "dispute",
      label: "Jobs the customer disputed",
      occurrences: disputed.length,
      detail: disputed.length ? `${disputed.length} job(s) where the customer did not accept the work as completed.` : null,
    },
    {
      key: "unverifiable",
      source: "unverifiable_job",
      label: "Jobs that could not be verified",
      occurrences: unverifiable.length,
      detail: unverifiable.length
        ? `${unverifiable.length} job(s) where the customer never responded, even after telephone attempts. A high count suggests the confirmation request itself is not landing.`
        : null,
    },
    {
      key: "inaccurate_requests",
      source: "provider_feedback",
      label: "Requests that did not describe the work accurately",
      occurrences: inaccurateRequests.length,
      detail: inaccurateRequests.length
        ? `${inaccurateRequests.length} provider(s) reported the request did not match the job. This points at the questions customers are asked, not at the providers.`
        : null,
    },
    {
      key: "unresponsive_customers",
      source: "customer_feedback",
      label: "Customers who did not respond to providers",
      occurrences: unresponsiveCustomers.length,
      detail: unresponsiveCustomers.length
        ? `${unresponsiveCustomers.length} provider(s) reported the customer went quiet after being introduced.`
        : null,
    },
    {
      key: "not_worthwhile",
      source: "provider_feedback",
      label: "Opportunities providers did not find worthwhile",
      occurrences: notWorthwhile.length,
      detail: notWorthwhile.length
        ? `${notWorthwhile.length} provider(s) said the opportunity was not worth their time. This is the figure most directly tied to whether providers keep paying.`
        : null,
    },
    {
      key: "suspicious_leads",
      source: "complaint",
      label: "Leads reported as suspicious",
      occurrences: suspicious.length,
      detail: suspicious.length
        ? `${suspicious.length} report(s). Most common reason: ${
            Object.entries(suspiciousByReason).sort((a, b) => b[1] - a[1])[0]?.[0]?.replace(/_/g, " ") || "n/a"
          }.`
        : null,
    },
  ];

  return candidates
    .filter((candidate) => candidate.occurrences > 0)
    .map((candidate) => ({
      ...candidate,
      // Flagged rather than hidden: an administrator may still want a second
      // entry, but should know one is already open.
      alreadyTracked: coveredSources.has(candidate.source),
    }))
    .sort((a, b) => b.occurrences - a.occurrences);
}

module.exports = {
  SOURCES,
  STATUSES,
  listActions,
  createAction,
  updateAction,
  listCandidates,
};
