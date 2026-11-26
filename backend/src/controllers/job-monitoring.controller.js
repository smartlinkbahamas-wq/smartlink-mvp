const { ZodError, z } = require("zod");

const { AppError } = require("../utils/app-error");
const monitoring = require("../services/job-monitoring.service");
const {
  resolveSecureLink,
  consumeSecureLink,
  contextFromRequest,
} = require("../services/secure-link.service");
const { requireSupabase } = require("../utils/supabase-guard");

/**
 * Two audiences, deliberately in one file because they are two halves of one
 * conversation: the customer confirming, and the administrator chasing when
 * they do not.
 */

const rating = z.coerce.number().int().min(1).max(5);

/**
 * The confirmation and the satisfaction survey arrive together, because the
 * customer sees one screen rather than two messages.
 *
 * Only `outcome` is required. Everything from overallRating down is optional:
 * a form demanding nine answers is one most people abandon, and a confirmation
 * with no rating is still worth far more than no confirmation at all.
 */
const confirmationSchema = z.object({
  outcome: z.enum([
    "completed_satisfactorily",
    "completed_with_concerns",
    "partially_completed",
    "not_completed",
  ]),
  comments: z.string().trim().max(2000).optional().or(z.literal("")),
  supportRequested: z.boolean().optional(),

  overallRating: rating.optional(),
  qualityRating: rating.optional(),
  timelinessRating: rating.optional(),
  professionalismRating: rating.optional(),
  communicationRating: rating.optional(),
  scopeAsAgreed: z.boolean().optional(),
  wouldRecommend: z.boolean().optional(),
  wouldUseAgain: z.boolean().optional(),
  publicReviewOptIn: z.boolean().optional(),
});

const attemptSchema = z.object({
  outcome: z.enum([
    "no_answer",
    "voicemail",
    "wrong_number",
    "reached_confirmed",
    "reached_disputed",
    "reached_no_comment",
  ]),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

const settingsSchema = z.object({
  provider_reminder_days_before: z.coerce.number().int().min(0).max(60).optional(),
  completion_request_days_after: z.coerce.number().int().min(0).max(60).optional(),
  overdue_reminder_days_after: z.coerce.number().int().min(0).max(60).optional(),
  admin_notify_days_after: z.coerce.number().int().min(0).max(90).optional(),
  escalation_days_after: z.coerce.number().int().min(0).max(120).optional(),
  unverifiable_after_days: z.coerce.number().int().min(1).max(90).optional(),
  required_phone_attempts: z.coerce.number().int().min(1).max(10).optional(),
  send_extra_reminder_before_calls: z.boolean().optional(),
});

function parse(schema, payload, message) {
  try {
    return schema.parse(payload || {});
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError(message, 400, { code: "validation_error", fields: error.flatten() });
    }
    throw error;
  }
}

/** Token from a header, never a query string — the server logs full URLs. */
function tokenFromRequest(req) {
  const token = req.get("x-document-token") || req.body?.token;
  if (!token) {
    throw new AppError("This link is not valid.", 400, { code: "missing_document_token" });
  }
  return String(token);
}

// --- Customer (link-authenticated, no account) -----------------------------

/** What the customer sees before answering. Nothing about cost or margin. */
async function getJobForConfirmation(req, res) {
  const link = await resolveSecureLink(tokenFromRequest(req), {
    purpose: "completion_confirmation",
    context: contextFromRequest(req),
  });

  const supabase = requireSupabase();
  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, expert_id, reference, job_name, description, customer_name, actual_completion_date, status")
    .eq("id", link.subject_id)
    .maybeSingle();

  if (error || !job) {
    throw new AppError("That job could not be found.", 404, { code: "job_not_found" });
  }

  const { data: expert } = await supabase
    .from("experts")
    .select("name, business_name")
    .eq("expert_id", job.expert_id)
    .maybeSingle();

  const existing = await monitoring.getConfirmation(job.id);

  return res.json({
    success: true,
    data: {
      job: {
        reference: job.reference,
        jobName: job.job_name,
        description: job.description,
        customerName: job.customer_name,
        completedOn: job.actual_completion_date,
        providerName: expert?.business_name || expert?.name || "your provider",
      },
      alreadyConfirmed: Boolean(existing),
      outcome: existing?.outcome || null,
    },
  });
}

async function submitConfirmation(req, res) {
  const payload = parse(confirmationSchema, req.body, "Choose one of the four options.");
  const context = contextFromRequest(req);

  const link = await resolveSecureLink(tokenFromRequest(req), {
    purpose: "completion_confirmation",
    context,
  });

  // Recorded before the link is consumed, so a failure part-way leaves the
  // customer able to try again rather than holding a spent link.
  const result = await monitoring.recordConfirmation(link.subject_id, {
    outcome: payload.outcome,
    comments: payload.comments,
    // Anything other than "completed satisfactorily" offers help, as specified.
    supportRequested:
      payload.supportRequested ?? payload.outcome !== "completed_satisfactorily",
    secureLinkId: link.id,
  });

  // The survey is recorded after the confirmation and cannot undo it. A
  // customer who answered the confirmation but hit a problem on the survey has
  // still answered the question that matters.
  let surveyRecorded = false;
  if (payload.overallRating) {
    try {
      const supabase = requireSupabase();
      const { data: job } = await supabase
        .from("jobs")
        .select("expert_id, lead_id")
        .eq("id", link.subject_id)
        .maybeSingle();

      const { submitCustomerSurvey } = require("../services/survey.service");
      await submitCustomerSurvey(link.subject_id, payload, {
        expertId: job?.expert_id || null,
        leadId: job?.lead_id || null,
      });
      surveyRecorded = true;
    } catch (surveyError) {
      console.warn("[surveys] confirmation recorded but survey was not:", surveyError.message);
    }
  }

  await consumeSecureLink(link.id, { detail: payload.outcome, context });

  const messages = {
    completed_satisfactorily: "Thank you. We have recorded that the work was completed.",
    completed_with_concerns: "Thank you. We have recorded your concerns and someone will look at this.",
    partially_completed: "Thank you. We have recorded that the work was only partly done and someone will look at this.",
    not_completed: "Thank you. We have recorded that the work was not completed and someone will look at this.",
  };

  return res.json({
    success: true,
    message: messages[payload.outcome],
    data: { outcome: payload.outcome, jobStatus: result.jobStatus, surveyRecorded },
  });
}

// --- Administrator ---------------------------------------------------------

async function getJobsNeedingAttention(req, res) {
  const result = await monitoring.listJobsNeedingAttention();
  return res.json({ success: true, data: result });
}

async function getMonitoringSettings(req, res) {
  const settings = await monitoring.getSettings();
  return res.json({ success: true, data: settings });
}

async function patchMonitoringSettings(req, res) {
  const payload = parse(settingsSchema, req.body, "Check the monitoring schedule.");
  const settings = await monitoring.updateSettings(payload);
  return res.json({ success: true, message: "Monitoring schedule saved.", data: settings });
}

async function getJobMonitoringDetail(req, res) {
  const jobId = req.params.id;
  const [events, attempts, notes, confirmation] = await Promise.all([
    monitoring.listEvents(jobId),
    monitoring.listVerificationAttempts(jobId),
    monitoring.listAdminNotes(jobId),
    monitoring.getConfirmation(jobId),
  ]);
  return res.json({ success: true, data: { events, attempts, notes, confirmation } });
}

async function postVerificationAttempt(req, res) {
  const payload = parse(attemptSchema, req.body, "Choose what happened on the call.");
  const result = await monitoring.recordVerificationAttempt(req.params.id, {
    outcome: payload.outcome,
    notes: payload.notes,
    recordedByUserId: req.adminUser?.userId || req.user?.userId || null,
  });
  return res.status(201).json({
    success: true,
    message: result.canMarkUnverifiable
      ? `Attempt ${result.attemptsMade} recorded. This job can now be marked unverifiable.`
      : `Attempt ${result.attemptsMade} of ${result.attemptsRequired} recorded.`,
    data: result,
  });
}

async function postMarkUnverifiable(req, res) {
  const job = await monitoring.markUnverifiable(req.params.id, {
    reason: req.body?.reason,
    recordedByUserId: req.adminUser?.userId || req.user?.userId || null,
  });
  return res.json({
    success: true,
    message: "Marked unverifiable. It will be counted as neither confirmed nor disputed.",
    data: job,
  });
}

async function postAdminNote(req, res) {
  const note = String(req.body?.note || "").trim();
  if (!note) {
    throw new AppError("Write a note before saving.", 400, { code: "empty_note" });
  }
  const saved = await monitoring.addAdminNote(
    req.params.id,
    note,
    req.adminUser?.userId || req.user?.userId || null,
  );
  return res.status(201).json({ success: true, message: "Note saved.", data: saved });
}


// --- Date change approval (administrator) ----------------------------------

const reviewSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  // Required on a rejection: a provider told "no" with no reason cannot act on
  // it, and the refusal becomes a complaint rather than a decision.
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
}).superRefine((value, ctx) => {
  if (value.decision === "rejected" && !value.notes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["notes"],
      message: "Give a reason when rejecting a date change.",
    });
  }
});

async function getPendingDateRevisions(req, res) {
  const revisions = await monitoring.listPendingDateRevisions();
  return res.json({ success: true, data: { revisions } });
}

async function patchDateRevision(req, res) {
  const payload = parse(reviewSchema, req.body, "Check the decision and try again.");
  const revision = await monitoring.reviewDateRevision(req.params.revisionId, {
    decision: payload.decision,
    notes: payload.notes,
    reviewedByUserId: req.adminUser?.userId || req.user?.userId || null,
  });

  return res.json({
    success: true,
    message:
      payload.decision === "approved"
        ? "Date change approved. The job now runs to the new date."
        : "Date change rejected. The original date stands.",
    data: revision,
  });
}

module.exports = {
  getJobForConfirmation,
  submitConfirmation,
  getJobsNeedingAttention,
  getMonitoringSettings,
  patchMonitoringSettings,
  getJobMonitoringDetail,
  postVerificationAttempt,
  postMarkUnverifiable,
  postAdminNote,
  getPendingDateRevisions,
  patchDateRevision,
};
