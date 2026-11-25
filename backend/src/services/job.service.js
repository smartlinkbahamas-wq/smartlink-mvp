const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");
const { round2 } = require("../utils/money");
const { recordStageEvent } = require("./pipeline.service");
const { getQuotation, allocateNumber, formatReference } = require("./quotation.service");

/**
 * Jobs: work a provider has actually been awarded.
 *
 * This is what closes the funnel. The platform could already say an
 * introduction was accepted, but nothing about whether it became paid work --
 * which is the question asked in every round of feedback.
 *
 * `source` is recorded at creation and never changed. Without it, a provider
 * entering their own existing customers inflates the platform's apparent
 * conversion, and no administrative report can separate work SmartLink
 * produced from work it merely recorded.
 */

const NOT_INSTALLED = "Job tracking is not set up yet. Run sql/install_jobs.sql.";

const JOB_STATUSES = [
  "awarded",
  "scheduled",
  "in_progress",
  "delayed",
  "provider_completed",
  "customer_confirmed",
  "disputed",
  "cancelled",
  "unverifiable",
];

// Statuses a provider may set. customer_confirmed, disputed and unverifiable
// are reached by the customer or an administrator, never by the provider --
// a provider marking their own work customer-confirmed would make the whole
// confirmation step meaningless.
const PROVIDER_SETTABLE = ["scheduled", "in_progress", "delayed", "provider_completed", "cancelled"];

const WORK_STARTED = ["in_progress", "delayed", "provider_completed", "customer_confirmed"];

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "jobs_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

/** Days overdue, derived. Negative means still within time. */
function overdueDays(job) {
  if (!job.expected_completion_date) return null;
  if (!["scheduled", "in_progress", "delayed"].includes(job.status)) return null;
  const due = new Date(`${job.expected_completion_date}T23:59:59Z`).getTime();
  return Math.floor((Date.now() - due) / (24 * 60 * 60 * 1000));
}

function decorate(job) {
  if (!job) return job;
  const days = overdueDays(job);
  return {
    ...job,
    overdue_days: days !== null && days > 0 ? days : 0,
    is_overdue: days !== null && days > 0,
    work_started: WORK_STARTED.includes(job.status),
  };
}

async function listJobs(expertId, { status = null } = {}) {
  const supabase = requireSupabase();
  let query = supabase
    .from("jobs")
    .select("*")
    .eq("expert_id", expertId)
    .order("created_at", { ascending: false });

  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) guard(error, "Could not load your jobs.");
  return (data || []).map(decorate);
}

async function getJob(expertId, jobId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .eq("expert_id", expertId)
    .maybeSingle();

  if (error) guard(error, "Could not load that job.");
  if (!data) {
    throw new AppError("That job could not be found.", 404, { code: "job_not_found" });
  }
  return decorate(data);
}

async function insertJob(expertId, fields) {
  const supabase = requireSupabase();
  const number = await allocateNumber(expertId, "job");

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      ...fields,
      expert_id: expertId,
      job_number: number,
      reference: formatReference("job", number),
      original_expected_completion_date: fields.expected_completion_date || null,
    })
    .select("*")
    .single();

  if (error) guard(error, "Could not create that job.");

  await recordStageEvent({
    subjectType: "job",
    subjectId: data.id,
    expertId,
    leadId: data.lead_id,
    fromStage: null,
    toStage: data.status,
    actorType: "expert",
    source: `job_created_${data.source}`,
  });

  return decorate(data);
}

/**
 * A job entered by hand.
 *
 * Forced to source 'provider_entered' regardless of what the request says.
 * Allowing a client to declare its own job 'smartlink' would let a provider
 * attribute off-platform work to the platform, and every conversion figure
 * downstream is computed from this field.
 */
async function createManualJob(expertId, payload) {
  return insertJob(expertId, {
    customer_name: String(payload.customerName).trim(),
    customer_email: payload.customerEmail?.trim().toLowerCase() || null,
    customer_phone: payload.customerPhone?.trim() || null,
    job_name: String(payload.jobName).trim(),
    description: payload.description?.trim() || null,
    agreed_price: payload.agreedPrice === undefined || payload.agreedPrice === null
      ? null
      : round2(payload.agreedPrice),
    expected_completion_date: payload.expectedCompletionDate || null,
    service_menu_item_id: payload.serviceMenuItemId || null,
    source: "provider_entered",
    status: payload.expectedCompletionDate ? "scheduled" : "awarded",
  });
}

/**
 * A job created from an approved quotation.
 *
 * source follows the quotation's origin: a quotation raised against a
 * SmartLink lead produced platform work; one the provider raised for their own
 * customer did not.
 */
async function createFromQuotation(expertId, quotationId, payload = {}) {
  const supabase = requireSupabase();
  const quotation = await getQuotation(expertId, quotationId);

  if (quotation.status !== "approved") {
    throw new AppError(
      "Only an approved quotation can be turned into a job.",
      409,
      { code: "quotation_not_approved" },
    );
  }

  const { data: existing } = await supabase
    .from("jobs")
    .select("id, reference")
    .eq("quotation_id", quotationId)
    .eq("expert_id", expertId)
    .maybeSingle();

  if (existing) {
    throw new AppError(`This quotation is already job ${existing.reference}.`, 409, {
      code: "already_a_job",
      jobId: existing.id,
    });
  }

  return insertJob(expertId, {
    quotation_id: quotationId,
    lead_id: quotation.lead_id,
    introduction_request_id: quotation.introduction_request_id,
    customer_name: quotation.customer_name,
    customer_email: quotation.customer_email,
    customer_phone: quotation.customer_phone,
    job_name: quotation.job_name,
    description: quotation.customer_summary,
    agreed_price: quotation.total,
    currency: quotation.currency,
    expected_completion_date: payload.expectedCompletionDate || null,
    source: quotation.lead_id ? "smartlink" : "provider_entered",
    status: payload.expectedCompletionDate ? "scheduled" : "awarded",
  });
}

/**
 * Changes a job's status.
 *
 * The date requirements are enforced here and again by check constraints, so
 * a direct database write cannot produce a job in progress with no expected
 * completion date -- which would make it invisible to every timeliness figure
 * and to the overdue dashboard.
 */
async function updateJobStatus(expertId, jobId, { status, actualCompletionDate, notes }) {
  const supabase = requireSupabase();
  const job = await getJob(expertId, jobId);

  if (!PROVIDER_SETTABLE.includes(status)) {
    throw new AppError(
      "That status can only be set by the customer or an administrator.",
      403,
      { code: "status_not_provider_settable", allowed: PROVIDER_SETTABLE },
    );
  }

  if (status === "in_progress" && !job.expected_completion_date) {
    throw new AppError(
      "Set an expected completion date before marking work in progress.",
      400,
      { code: "expected_date_required" },
    );
  }

  if (status === "provider_completed" && !actualCompletionDate) {
    throw new AppError("Record the date the work was completed.", 400, {
      code: "actual_date_required",
    });
  }

  const update = {
    status,
    completion_notes: notes?.trim() || job.completion_notes,
    updated_at: new Date().toISOString(),
  };
  if (actualCompletionDate) update.actual_completion_date = actualCompletionDate;

  const { data, error } = await supabase
    .from("jobs")
    .update(update)
    .eq("id", jobId)
    .eq("expert_id", expertId)
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not update that job.");
  if (!data) {
    throw new AppError("That job could not be found.", 404, { code: "job_not_found" });
  }

  await recordStageEvent({
    subjectType: "job",
    subjectId: jobId,
    expertId,
    leadId: data.lead_id,
    fromStage: job.status,
    toStage: status,
    actorType: "expert",
    source: "provider_update",
    notes: notes?.trim() || null,
  });

  // The provider saying it is done starts the customer's side: silence must
  // never count as confirmation, so the customer is asked immediately rather
  // than waiting for the next scheduled sweep.
  //
  // Cannot throw: a provider marking work complete must not fail because an
  // email did not go out. The scheduler chases it afterwards regardless.
  if (status === "provider_completed") {
    try {
      const { sendCustomerConfirmationRequest } = require("./job-monitoring-runner.service");
      const { loadProvider } = require("./quotation.service");
      const provider = await loadProvider(expertId).catch(() => null);
      const businessName = provider?.business_name || provider?.name || "your provider";
      await sendCustomerConfirmationRequest(data, businessName);
    } catch (error) {
      console.warn("[jobs] could not ask the customer to confirm:", error.message);
    }
  }

  return decorate(data);
}

/**
 * Requests a new expected completion date.
 *
 * Free before work starts; needs administrator approval afterwards. The
 * original date, every revision and the reason are all retained -- that was
 * specified, and it is also the only way a timeliness figure can be defended
 * if a provider disputes it.
 */
async function reviseExpectedDate(expertId, jobId, { requestedDate, reason }) {
  const supabase = requireSupabase();
  const job = await getJob(expertId, jobId);

  if (["customer_confirmed", "cancelled", "unverifiable"].includes(job.status)) {
    throw new AppError("This job is closed and its dates can no longer be changed.", 409, {
      code: "job_closed",
    });
  }

  const needsApproval = job.work_started;

  const { data: revision, error } = await supabase
    .from("job_date_revisions")
    .insert({
      job_id: jobId,
      expert_id: expertId,
      previous_date: job.expected_completion_date,
      requested_date: requestedDate,
      reason: String(reason).trim(),
      approval_status: needsApproval ? "pending" : "auto",
    })
    .select("*")
    .single();

  if (error) guard(error, "Could not record that date change.");

  // Applied immediately only when no approval is needed. Otherwise the job
  // keeps its current date until an administrator decides, so the overdue
  // figures do not quietly move while a request is outstanding.
  let updatedJob = job;
  if (!needsApproval) {
    const { data, error: updateError } = await supabase
      .from("jobs")
      .update({
        expected_completion_date: requestedDate,
        original_expected_completion_date:
          job.original_expected_completion_date || job.expected_completion_date || requestedDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .eq("expert_id", expertId)
      .select("*")
      .single();

    if (updateError) guard(updateError, "Could not apply that date change.");
    updatedJob = decorate(data);

    // The trail is cleared so the new deadline earns its own notices.
    // Without this, a job moved from last week to next month would never be
    // chased again -- every notice for it had already been sent once.
    const { resetMonitoring } = require("./job-monitoring.service");
    await resetMonitoring(jobId);
  }

  return {
    job: updatedJob,
    revision,
    requiresApproval: needsApproval,
    message: needsApproval
      ? "Work has already started, so an administrator needs to approve this change. The current date stands until then."
      : "The expected completion date has been updated.",
  };
}

async function listDateRevisions(expertId, jobId) {
  await getJob(expertId, jobId); // ownership check
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("job_date_revisions")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });

  if (error) guard(error, "Could not load the date history.");
  return data || [];
}

module.exports = {
  JOB_STATUSES,
  PROVIDER_SETTABLE,
  overdueDays,
  decorate,
  listJobs,
  getJob,
  createManualJob,
  createFromQuotation,
  updateJobStatus,
  reviseExpectedDate,
  listDateRevisions,
};
