const { ZodError, z } = require("zod");

const { AppError } = require("../utils/app-error");
const improvement = require("../services/improvement.service");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.");

const createSchema = z.object({
  source: z.enum(improvement.SOURCES),
  sourceTicketId: z.string().uuid().optional().nullable(),
  sourceJobId: z.string().uuid().optional().nullable(),
  description: z.string().trim().min(10, "Describe what needs improving.").max(4000),
  category: z.string().trim().max(120).optional().or(z.literal("")),
  possibleRootCause: z.string().trim().max(2000).optional().or(z.literal("")),
  correctiveAction: z.string().trim().max(2000).optional().or(z.literal("")),
  assignedToName: z.string().trim().max(120).optional().or(z.literal("")),
  targetDate: isoDate.optional().nullable(),
});

const updateSchema = z.object({
  status: z.enum(improvement.STATUSES).optional(),
  description: z.string().trim().min(10).max(4000).optional(),
  category: z.string().trim().max(120).optional().or(z.literal("")),
  possibleRootCause: z.string().trim().max(2000).optional().or(z.literal("")),
  correctiveAction: z.string().trim().max(2000).optional().or(z.literal("")),
  assignedToName: z.string().trim().max(120).optional().or(z.literal("")),
  targetDate: isoDate.optional().nullable(),
  effectivenessReview: z.string().trim().max(2000).optional().or(z.literal("")),
  wasEffective: z.boolean().optional(),
}).superRefine((value, ctx) => {
  // Mirrors the database constraint, so the message lands on the right field
  // rather than arriving as a constraint name.
  if (value.wasEffective !== undefined && !value.effectivenessReview) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectivenessReview"],
      message: "Write the review before saying whether it worked.",
    });
  }
  if (value.status === "completed" && value.correctiveAction === "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["correctiveAction"],
      message: "Record what was actually done before marking this complete.",
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

async function getActions(req, res) {
  const actions = await improvement.listActions({
    status: req.query?.status ? String(req.query.status) : null,
  });
  return res.json({ success: true, data: { actions } });
}

/** Patterns worth considering. Nothing here creates an entry — a person does. */
async function getCandidates(req, res) {
  const candidates = await improvement.listCandidates();
  return res.json({ success: true, data: { candidates } });
}

async function postAction(req, res) {
  const payload = parse(createSchema, req.body, "Check the entry and try again.");
  const action = await improvement.createAction(
    payload,
    req.adminUser?.userId || req.user?.userId || null,
  );
  return res.status(201).json({ success: true, message: `${action.reference} added.`, data: action });
}

async function patchAction(req, res) {
  const payload = parse(updateSchema, req.body, "Check the changes and try again.");
  const action = await improvement.updateAction(req.params.id, payload);
  return res.json({ success: true, message: "Entry saved.", data: action });
}

module.exports = {
  getActions,
  getCandidates,
  postAction,
  patchAction,
};
