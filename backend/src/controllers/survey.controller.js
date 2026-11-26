const { ZodError, z } = require("zod");

const { AppError } = require("../utils/app-error");
const { resolveExpertIdForUser } = require("../utils/expert-identity");
const surveys = require("../services/survey.service");

/**
 * The provider follow-up survey.
 *
 * The customer's survey has no controller of its own: it arrives with the
 * completion confirmation, because the customer gets one screen rather than
 * two messages.
 */

const providerSurveySchema = z
  .object({
    jobId: z.string().uuid().optional().nullable(),
    introductionRequestId: z.string().uuid().optional().nullable(),

    // The only required answer. It is the provider's independent account of
    // whether the opportunity became work, which the platform compares against
    // what its own jobs table says.
    resultedInJob: z.boolean(),

    wasCompleted: z.boolean().optional().nullable(),
    requestDescribedAccurately: z.boolean().optional().nullable(),
    customerResponsive: z.boolean().optional().nullable(),
    opportunityWorthwhile: z.boolean().optional().nullable(),
    wouldAcceptSimilar: z.boolean().optional().nullable(),
    suggestions: z.string().trim().max(4000).optional().or(z.literal("")),
  })
  .superRefine((value, ctx) => {
    if (!value.jobId && !value.introductionRequestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["jobId"],
        message: "The survey must be about a job or an opportunity.",
      });
    }
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

async function getPendingSurveys(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const jobs = await surveys.listPendingProviderSurveys(expertId);
  return res.json({ success: true, data: { jobs } });
}

async function postProviderSurvey(req, res) {
  const payload = parse(providerSurveySchema, req.body, "Check your answers and try again.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const survey = await surveys.submitProviderSurvey(expertId, payload);
  return res.status(201).json({
    success: true,
    message: "Thank you — your feedback helps us send you better opportunities.",
    data: survey,
  });
}

/** A provider's own survey figures. Always with the response rate. */
async function getMySurveyStatistics(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const stats = await surveys.getSurveyStatistics({ expertId });
  return res.json({ success: true, data: stats });
}

/** Platform-wide figures, for administrators. */
async function getPlatformSurveyStatistics(req, res) {
  const stats = await surveys.getSurveyStatistics({});
  return res.json({ success: true, data: stats });
}

module.exports = {
  getPendingSurveys,
  postProviderSurvey,
  getMySurveyStatistics,
  getPlatformSurveyStatistics,
};
