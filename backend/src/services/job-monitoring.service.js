const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");

/**
 * Job monitoring: the schedule that chases a job to a confirmed outcome.
 *
 * The specified sequence, all timeframes configurable rather than hardcoded:
 *
 *   2 days before the expected date  -> remind the provider
 *   on the date                      -> ask the provider to confirm completion
 *   2 days after                     -> overdue reminder
 *   3 days after                     -> notify an administrator
 *   7 days after                     -> escalate
 *   on provider completion           -> ask the customer to confirm
 *   7 days with no customer answer   -> administrator telephones
 *   2 unanswered calls               -> mark Unverifiable
 *
 * Two rules govern all of it:
 *
 * 1. Silence is never confirmation. A job nobody answers for becomes
 *    Unverifiable -- counted as neither confirmed nor disputed -- rather than
 *    quietly completed.
 *
 * 2. Reminders stop the moment a job is completed, confirmed or cancelled.
 *    This is the adoption risk: a provider who gets chased about work they
 *    already finished mutes everything, and then none of this matters.
 */

const NOT_INSTALLED = "Job monitoring is not set up yet. Run sql/install_job_monitoring.sql.";

// Statuses the schedule still chases. Anything outside this is settled, and a
// settled job must never produce another notice.
const OPEN_STATUSES = ["scheduled", "in_progress", "delayed"];
const AWAITING_CUSTOMER = "provider_completed";

const CONFIRMATION_OUTCOMES = [
  "completed_satisfactorily",
  "completed_with_concerns",
  "partially_completed",
  "not_completed",
];

// Outcomes that mean the customer was actually reached, which ends the
// telephone sequence whatever they said.
const REACHED_OUTCOMES = ["reached_confirmed", "reached_disputed", "reached_no_comment"];

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "job_monitoring_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

/** Whole days from the expected date to today. Negative means still to come. */
function daysFromExpected(expectedDate) {
  if (!expectedDate) return null;
  const expected = new Date(`${expectedDate}T00:00:00Z`).getTime();
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((today - expected) / (24 * 60 * 60 * 1000));
}

const DEFAULT_SETTINGS = {
  provider_reminder_days_before: 2,
  completion_request_days_after: 0,
  overdue_reminder_days_after: 2,
  admin_notify_days_after: 3,
  escalation_days_after: 7,
  unverifiable_after_days: 7,
  required_phone_attempts: 2,
  send_extra_reminder_before_calls: true,
};

async function getSettings() {
  const supabase = requireSupabase();
  const { data, error } = await supabase.from("job_monitoring_settings").select("*").maybeSingle();

  if (error) {
    // The schedule must not stop because the settings row is unreadable; the
    // documented defaults are the same numbers the table is seeded with.
    if (tableIsMissing(error)) return { ...DEFAULT_SETTINGS, installed: false };
    throw new AppError("Could not load the monitoring settings.", 500, error.message);
  }

  return { ...DEFAULT_SETTINGS, ...(data || {}), installed: true };
}

async function updateSettings(payload) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("job_monitoring_settings")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", true)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23514") {
      throw new AppError(
        "Check the order: the overdue reminder must come before the administrator notice, which must come before escalation.",
        400,
        { code: "invalid_monitoring_schedule" },
      );
    }
    guard(error, "Could not save the monitoring settings.");
  }
  if (!data) {
    throw new AppError(NOT_INSTALLED, 503, { code: "job_monitoring_not_installed" });
  }
  return data;
}

/**
 * Records that a notice went out.
 *
 * The unique index on (job_id, event_type) is what stops the same notice
 * repeating every hour. A conflict is the normal, expected outcome on a second
 * attempt and is reported as "already sent" rather than as a failure.
 */
async function recordEvent(jobId, eventType, { sentTo = null, detail = null } = {}) {
  const supabase = requireSupabase();
  const { error } = await supabase
    .from("job_monitoring_events")
    .insert({ job_id: jobId, event_type: eventType, sent_to: sentTo, detail });

  if (error) {
    if (error.code === "23505") return { sent: false, reason: "already_sent" };
    if (tableIsMissing(error)) return { sent: false, reason: "not_installed" };
    console.warn(`[job-monitoring] could not record ${eventType}:`, error.message);
    return { sent: false, reason: "error" };
  }
  return { sent: true };
}

async function listEvents(jobId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("job_monitoring_events")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  if (error) {
    if (tableIsMissing(error)) return [];
    throw new AppError("Could not load the monitoring history.", 500, error.message);
  }
  return data || [];
}

/**
 * Clears the trail so a rescheduled job earns a fresh set of notices.
 *
 * Called when an expected completion date is legitimately revised. Without
 * this, a job moved from last week to next month would never be chased again,
 * because every notice for it had already been sent once.
 */
async function resetMonitoring(jobId) {
  const supabase = requireSupabase();
  const { error } = await supabase.from("job_monitoring_events").delete().eq("job_id", jobId);
  if (error && !tableIsMissing(error)) {
    console.warn("[job-monitoring] could not reset trail:", error.message);
  }
}

// --- Customer confirmation -------------------------------------------------

async function getConfirmation(jobId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("job_completion_confirmations")
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();

  if (error) {
    if (tableIsMissing(error)) return null;
    throw new AppError("Could not load the confirmation.", 500, error.message);
  }
  return data;
}

/**
 * Records the customer's answer and moves the job accordingly.
 *
 * Concerns, partial and not-completed all move the job to 'disputed' rather
 * than 'customer_confirmed'. Only "completed satisfactorily" confirms it --
 * anything else is a job an administrator needs to look at, which is the whole
 * point of asking.
 */
async function recordConfirmation(jobId, { outcome, comments, supportRequested, secureLinkId }) {
  if (!CONFIRMATION_OUTCOMES.includes(outcome)) {
    throw new AppError("Choose one of the four options.", 400, { code: "invalid_outcome" });
  }

  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("job_completion_confirmations")
    .insert({
      job_id: jobId,
      outcome,
      comments: comments?.trim() || null,
      support_requested: Boolean(supportRequested),
      verification_method: "secure_link",
      secure_link_id: secureLinkId || null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new AppError("This job has already been confirmed.", 409, {
        code: "already_confirmed",
      });
    }
    guard(error, "Could not record that confirmation.");
  }

  const nextStatus = outcome === "completed_satisfactorily" ? "customer_confirmed" : "disputed";

  const { error: jobError } = await supabase
    .from("jobs")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", jobId);

  if (jobError) {
    // The customer's answer is recorded, which is the part that matters. A
    // failed status update is recoverable by an administrator; losing the
    // answer is not.
    console.warn("[job-monitoring] confirmation recorded but status not updated:", jobError.message);
  }

  const { recordStageEvent } = require("./pipeline.service");
  await recordStageEvent({
    subjectType: "job",
    subjectId: jobId,
    fromStage: AWAITING_CUSTOMER,
    toStage: nextStatus,
    actorType: "client",
    source: "customer_confirmation",
    notes: `Customer reported: ${outcome.replace(/_/g, " ")}.`,
  });

  return { confirmation: data, jobStatus: nextStatus };
}

// --- Telephone verification and the Unverifiable category -------------------

async function listVerificationAttempts(jobId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("job_verification_attempts")
    .select("*")
    .eq("job_id", jobId)
    .order("attempt_number", { ascending: true });

  if (error) {
    if (tableIsMissing(error)) return [];
    throw new AppError("Could not load the call history.", 500, error.message);
  }
  return data || [];
}

/**
 * Records a telephone attempt.
 *
 * The attempt number is derived rather than supplied, so two administrators
 * cannot both record "attempt 2" and leave the count wrong. A collision on the
 * unique index means someone else got there first, which is reported rather
 * than silently overwritten.
 */
async function recordVerificationAttempt(jobId, { outcome, notes, recordedByUserId }) {
  const supabase = requireSupabase();
  const existing = await listVerificationAttempts(jobId);

  const { data, error } = await supabase
    .from("job_verification_attempts")
    .insert({
      job_id: jobId,
      attempt_number: existing.length + 1,
      outcome,
      notes: notes?.trim() || null,
      recorded_by_user_id: recordedByUserId || null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new AppError(
        "Another administrator recorded an attempt at the same time. Reload and try again.",
        409,
        { code: "attempt_conflict" },
      );
    }
    if (error.code === "23514") {
      throw new AppError("Choose a valid call outcome.", 400, { code: "invalid_call_outcome" });
    }
    guard(error, "Could not record that call.");
  }

  const settings = await getSettings();
  const attempts = [...existing, data];
  const reached = attempts.some((attempt) => REACHED_OUTCOMES.includes(attempt.outcome));

  return {
    attempt: data,
    attemptsMade: attempts.length,
    attemptsRequired: settings.required_phone_attempts,
    customerReached: reached,
    // Unverifiable requires the configured number of attempts AND that the
    // customer was never actually reached. Someone who answered and said
    // nothing useful is a different case from someone who never answered.
    canMarkUnverifiable: !reached && attempts.length >= settings.required_phone_attempts,
  };
}

/**
 * Marks a job Unverifiable.
 *
 * Refused until the required telephone attempts have been made, because the
 * category only means anything if the process behind it was followed. An
 * Unverifiable job counts as neither confirmed nor disputed in reporting.
 */
async function markUnverifiable(jobId, { reason, recordedByUserId } = {}) {
  const supabase = requireSupabase();
  const settings = await getSettings();
  const attempts = await listVerificationAttempts(jobId);

  const reached = attempts.some((attempt) => REACHED_OUTCOMES.includes(attempt.outcome));
  if (reached) {
    throw new AppError(
      "The customer was reached, so this job cannot be marked unverifiable. Record what they said instead.",
      409,
      { code: "customer_was_reached" },
    );
  }

  if (attempts.length < settings.required_phone_attempts) {
    throw new AppError(
      `Record ${settings.required_phone_attempts} telephone attempts before marking this unverifiable. ${attempts.length} so far.`,
      409,
      {
        code: "insufficient_attempts",
        attemptsMade: attempts.length,
        attemptsRequired: settings.required_phone_attempts,
      },
    );
  }

  const { data, error } = await supabase
    .from("jobs")
    .update({ status: "unverifiable", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not update that job.");
  if (!data) {
    throw new AppError("That job could not be found.", 404, { code: "job_not_found" });
  }

  if (reason) {
    await addAdminNote(jobId, reason, recordedByUserId);
  }

  const { recordStageEvent } = require("./pipeline.service");
  await recordStageEvent({
    subjectType: "job",
    subjectId: jobId,
    expertId: data.expert_id,
    fromStage: AWAITING_CUSTOMER,
    toStage: "unverifiable",
    actorType: "admin",
    actorUserId: recordedByUserId || null,
    source: "unverifiable_after_calls",
    notes: `Completion could not be verified after ${attempts.length} telephone attempts.`,
  });

  return data;
}

// --- Administrator notes ---------------------------------------------------

async function addAdminNote(jobId, note, authorUserId = null) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("job_admin_notes")
    .insert({ job_id: jobId, note: String(note).trim(), author_user_id: authorUserId })
    .select("*")
    .single();

  if (error) guard(error, "Could not save that note.");
  return data;
}

async function listAdminNotes(jobId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("job_admin_notes")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });

  if (error) {
    if (tableIsMissing(error)) return [];
    throw new AppError("Could not load the notes.", 500, error.message);
  }
  return data || [];
}

// --- The overdue dashboard -------------------------------------------------

/**
 * Jobs that should be finished and are not, plus jobs awaiting a customer.
 *
 * Everything an administrator needs to act, in one query per table rather than
 * per job. Provider cost and profit are deliberately absent: administrators
 * see job values, never margins.
 */
async function listJobsNeedingAttention() {
  const supabase = requireSupabase();
  const settings = await getSettings();

  const { data: jobs, error } = await supabase
    .from("jobs")
    .select(
      "id, expert_id, reference, customer_name, customer_email, customer_phone, job_name, status, source, agreed_price, currency, expected_completion_date, original_expected_completion_date, actual_completion_date, created_at",
    )
    .in("status", [...OPEN_STATUSES, AWAITING_CUSTOMER, "disputed"])
    .order("expected_completion_date", { ascending: true, nullsFirst: false });

  if (error) guard(error, "Could not load jobs needing attention.");
  if (!jobs || jobs.length === 0) return { settings, jobs: [] };

  const jobIds = jobs.map((job) => job.id);
  const expertIds = [...new Set(jobs.map((job) => job.expert_id))];

  const [experts, events, confirmations, attempts] = await Promise.all([
    supabase.from("experts").select("expert_id, name, business_name, business_email").in("expert_id", expertIds),
    supabase.from("job_monitoring_events").select("job_id, event_type, created_at").in("job_id", jobIds),
    supabase.from("job_completion_confirmations").select("job_id, outcome, confirmed_at").in("job_id", jobIds),
    supabase.from("job_verification_attempts").select("job_id, attempt_number, outcome, attempted_at").in("job_id", jobIds),
  ]);

  const expertsById = new Map((experts.data || []).map((e) => [e.expert_id, e]));

  const eventsByJob = new Map();
  for (const event of events.data || []) {
    if (!eventsByJob.has(event.job_id)) eventsByJob.set(event.job_id, []);
    eventsByJob.get(event.job_id).push(event);
  }

  const confirmationByJob = new Map((confirmations.data || []).map((c) => [c.job_id, c]));

  const attemptsByJob = new Map();
  for (const attempt of attempts.data || []) {
    if (!attemptsByJob.has(attempt.job_id)) attemptsByJob.set(attempt.job_id, []);
    attemptsByJob.get(attempt.job_id).push(attempt);
  }

  const decorated = jobs.map((job) => {
    const days = daysFromExpected(job.expected_completion_date);
    const jobEvents = eventsByJob.get(job.id) || [];
    const jobAttempts = attemptsByJob.get(job.id) || [];
    const reached = jobAttempts.some((a) => REACHED_OUTCOMES.includes(a.outcome));
    const expert = expertsById.get(job.expert_id);

    return {
      ...job,
      provider_name: expert?.business_name || expert?.name || null,
      provider_email: expert?.business_email || null,
      days_overdue: days !== null && days > 0 && OPEN_STATUSES.includes(job.status) ? days : 0,
      is_overdue: days !== null && days > 0 && OPEN_STATUSES.includes(job.status),
      // The question that gets asked about every late job: did the provider
      // respond to any of the chasing?
      notices_sent: jobEvents.map((e) => e.event_type),
      reminders_answered:
        jobEvents.length > 0 && !OPEN_STATUSES.includes(job.status) ? true : null,
      escalated: jobEvents.some((e) => e.event_type === "escalated"),
      confirmation: confirmationByJob.get(job.id) || null,
      verification_attempts: jobAttempts.length,
      customer_reached: reached,
      awaiting_customer_days:
        job.status === AWAITING_CUSTOMER && job.actual_completion_date
          ? daysFromExpected(job.actual_completion_date)
          : null,
      needs_telephone_verification:
        job.status === AWAITING_CUSTOMER &&
        !confirmationByJob.get(job.id) &&
        job.actual_completion_date !== null &&
        (daysFromExpected(job.actual_completion_date) ?? 0) >= settings.unverifiable_after_days,
      can_mark_unverifiable:
        job.status === AWAITING_CUSTOMER &&
        !confirmationByJob.get(job.id) &&
        !reached &&
        jobAttempts.length >= settings.required_phone_attempts,
    };
  });

  return { settings, jobs: decorated };
}


// --- Date change approval ---------------------------------------------------

/**
 * Date revisions waiting for an administrator.
 *
 * Revisions made before work started are recorded as 'auto' and never appear
 * here -- a provider adjusting a date on work they have not begun needs no
 * permission. Only changes requested after work is in progress require review,
 * which is the rule as specified.
 */
async function listPendingDateRevisions() {
  const supabase = requireSupabase();

  const { data: revisions, error } = await supabase
    .from("job_date_revisions")
    .select("*")
    .eq("approval_status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    if (tableIsMissing(error)) return [];
    throw new AppError("Could not load the date change requests.", 500, error.message);
  }
  if (!revisions || revisions.length === 0) return [];

  // The request is unreadable without the job and the provider behind it, so
  // both are stitched on rather than left as ids.
  const jobIds = [...new Set(revisions.map((r) => r.job_id))];
  const expertIds = [...new Set(revisions.map((r) => r.expert_id).filter(Boolean))];

  const [jobsResult, expertsResult] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, reference, job_name, customer_name, status, expected_completion_date, original_expected_completion_date, agreed_price, currency, source")
      .in("id", jobIds),
    expertIds.length
      ? supabase.from("experts").select("expert_id, name, business_name").in("expert_id", expertIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const jobsById = new Map((jobsResult.data || []).map((j) => [j.id, j]));
  const expertsById = new Map((expertsResult.data || []).map((e) => [e.expert_id, e]));

  return revisions.map((revision) => {
    const job = jobsById.get(revision.job_id) || null;
    const expert = expertsById.get(revision.expert_id) || null;
    const slip =
      revision.previous_date && revision.requested_date
        ? Math.round(
            (new Date(`${revision.requested_date}T00:00:00Z`).getTime() -
              new Date(`${revision.previous_date}T00:00:00Z`).getTime()) /
              (24 * 60 * 60 * 1000),
          )
        : null;

    return {
      ...revision,
      job,
      provider_name: expert?.business_name || expert?.name || null,
      // How much later the provider is asking for. The number an
      // administrator actually judges the request on.
      days_later: slip,
    };
  });
}

/**
 * Approves or rejects a requested date change.
 *
 * Approving applies the date and clears the monitoring trail, so the new
 * deadline earns its own notices. Without that reset the job would never be
 * chased again -- every notice for it had already been sent against the old
 * date.
 *
 * Rejecting leaves the date untouched, which is the point: the original
 * deadline stands and the timeliness figures continue against it.
 */
async function reviewDateRevision(revisionId, { decision, notes, reviewedByUserId }) {
  if (!["approved", "rejected"].includes(decision)) {
    throw new AppError("Choose approve or reject.", 400, { code: "invalid_decision" });
  }

  const supabase = requireSupabase();

  const { data: revision, error: loadError } = await supabase
    .from("job_date_revisions")
    .select("*")
    .eq("id", revisionId)
    .maybeSingle();

  if (loadError) guard(loadError, "Could not load that request.");
  if (!revision) {
    throw new AppError("That request could not be found.", 404, { code: "revision_not_found" });
  }
  if (revision.approval_status !== "pending") {
    throw new AppError(
      `This request has already been ${revision.approval_status}.`,
      409,
      { code: "revision_already_reviewed" },
    );
  }

  // Conditional on still being pending, so two administrators deciding at the
  // same moment cannot both apply a change.
  const { data: updated, error } = await supabase
    .from("job_date_revisions")
    .update({
      approval_status: decision,
      review_notes: notes?.trim() || null,
      reviewed_by_user_id: reviewedByUserId || null,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", revisionId)
    .eq("approval_status", "pending")
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not record that decision.");
  if (!updated) {
    throw new AppError(
      "Another administrator answered this request first. Reload and check.",
      409,
      { code: "revision_already_reviewed" },
    );
  }

  if (decision === "approved") {
    const { data: job } = await supabase
      .from("jobs")
      .select("original_expected_completion_date")
      .eq("id", revision.job_id)
      .maybeSingle();

    const update = {
      expected_completion_date: revision.requested_date,
      updated_at: new Date().toISOString(),
    };

    // The original deadline is captured once and never overwritten, so it
    // survives however many times the date later moves. Every timeliness
    // figure is measured against it rather than against the latest extension.
    if (!job?.original_expected_completion_date) {
      update.original_expected_completion_date = revision.previous_date || revision.requested_date;
    }

    const { error: jobError } = await supabase
      .from("jobs")
      .update(update)
      .eq("id", revision.job_id);

    if (jobError) {
      throw new AppError(
        "The decision was recorded but the job date could not be updated.",
        500,
        jobError.message,
      );
    }

    // The new deadline earns its own notices. Without this the job would never
    // be chased again, because every notice had been sent against the old date.
    await resetMonitoring(revision.job_id);
  }

  const { recordStageEvent } = require("./pipeline.service");
  await recordStageEvent({
    subjectType: "job_date_revision",
    subjectId: revisionId,
    expertId: revision.expert_id,
    fromStage: "pending",
    toStage: decision,
    actorType: "admin",
    actorUserId: reviewedByUserId || null,
    source: "date_revision_review",
    notes: notes?.trim() || null,
  });

  return updated;
}

async function listDateRevisionsForJob(jobId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("job_date_revisions")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });

  if (error) {
    if (tableIsMissing(error)) return [];
    throw new AppError("Could not load the date history.", 500, error.message);
  }
  return data || [];
}

module.exports = {
  OPEN_STATUSES,
  AWAITING_CUSTOMER,
  CONFIRMATION_OUTCOMES,
  REACHED_OUTCOMES,
  daysFromExpected,
  getSettings,
  updateSettings,
  recordEvent,
  listEvents,
  resetMonitoring,
  getConfirmation,
  recordConfirmation,
  listVerificationAttempts,
  recordVerificationAttempt,
  markUnverifiable,
  addAdminNote,
  listAdminNotes,
  listJobsNeedingAttention,
  listPendingDateRevisions,
  reviewDateRevision,
  listDateRevisionsForJob,
};
