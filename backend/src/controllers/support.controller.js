const { ZodError, z } = require("zod");

const { AppError } = require("../utils/app-error");
const { resolveExpertIdForUser } = require("../utils/expert-identity");
const support = require("../services/support.service");

/**
 * Three audiences on one resource, with different rules.
 *
 * Administrators see everything. Providers see the summary and, only if an
 * administrator decided to share it, the original. Customers raise tickets and
 * read their own thread.
 */

const createSchema = z.object({
  category: z.enum(["platform_support", "job_complaint"]),
  subject: z.string().trim().min(1, "Give the ticket a subject.").max(200),
  body: z.string().trim().min(1, "Describe the problem.").max(8000),
  jobId: z.string().uuid().optional().nullable(),
});

const messageSchema = z.object({
  body: z.string().trim().min(1, "Write a message.").max(8000),
  // Administrators choose; everyone else has it decided for them.
  visibleTo: z.enum(["internal", "provider", "customer", "all"]).optional(),
});

const updateSchema = z.object({
  status: z.enum(support.TICKET_STATUSES).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  assignedToUserId: z.string().uuid().optional().nullable(),
  resolution: z.string().trim().max(4000).optional().or(z.literal("")),
});

const summarySchema = z.object({
  summary: z
    .string()
    .trim()
    .min(10, "Write a summary the provider can act on.")
    .max(4000),
});

const shareSchema = z.object({
  share: z.boolean(),
  reason: z.string().trim().max(2000).optional().or(z.literal("")),
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

// --- Provider --------------------------------------------------------------

async function getMyTickets(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const tickets = await support.listTicketsForProvider(expertId);
  return res.json({ success: true, data: { tickets } });
}

async function getMyTicket(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const result = await support.getTicketForProvider(expertId, req.params.id);
  return res.json({ success: true, data: result });
}

async function createMyTicket(req, res) {
  const payload = parse(createSchema, req.body, "Check the ticket details.");

  // A provider can only raise platform support. A provider "complaining" about
  // a job is a different conversation and does not belong in the category that
  // carries the customer-protection rules.
  if (payload.category !== "platform_support") {
    throw new AppError(
      "Providers can raise platform support requests here. For a dispute about a job, contact an administrator.",
      400,
      { code: "category_not_allowed" },
    );
  }

  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const ticket = await support.createTicket({
    ...payload,
    raisedBy: "provider",
    raisedByUserId: req.user?.userId || null,
    expertId,
  });

  return res.status(201).json({ success: true, message: `Ticket ${ticket.reference} raised.`, data: ticket });
}

async function postMyMessage(req, res) {
  const payload = parse(messageSchema, req.body, "Write a message.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);

  // Ownership check, and it also enforces that an unsummarised complaint is
  // invisible -- a provider cannot reply to something they cannot see.
  await support.getTicketForProvider(expertId, req.params.id);

  const message = await support.addMessage(req.params.id, {
    authorType: "provider",
    authorUserId: req.user?.userId || null,
    body: payload.body,
    // Forced: a provider cannot write an internal note or address the customer
    // directly. Their replies go to the administrator handling the ticket.
    visibleTo: "provider",
  });

  return res.status(201).json({ success: true, message: "Message added.", data: message });
}

async function postRequestOriginal(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const ticket = await support.requestOriginal(expertId, req.params.id, req);
  return res.json({
    success: true,
    message: "Request sent. An administrator will decide whether to share the original.",
    data: ticket,
  });
}

// --- Administrator ---------------------------------------------------------

async function getTickets(req, res) {
  const tickets = await support.listTickets({
    status: req.query?.status ? String(req.query.status) : null,
    category: req.query?.category ? String(req.query.category) : null,
  });
  return res.json({ success: true, data: { tickets } });
}

async function getTicket(req, res) {
  const result = await support.getTicketForAdmin(req.params.id);
  return res.json({ success: true, data: result });
}

async function postAdminMessage(req, res) {
  const payload = parse(messageSchema, req.body, "Write a message.");
  const message = await support.addMessage(req.params.id, {
    authorType: "administrator",
    authorUserId: req.adminUser?.userId || req.user?.userId || null,
    body: payload.body,
    visibleTo: payload.visibleTo || "internal",
  });
  return res.status(201).json({ success: true, message: "Message added.", data: message });
}

async function patchTicket(req, res) {
  const payload = parse(updateSchema, req.body, "Check the changes.");
  const ticket = await support.updateTicket(
    req.params.id,
    payload,
    req.adminUser?.userId || req.user?.userId || null,
    req,
  );
  return res.json({ success: true, message: "Ticket updated.", data: ticket });
}

async function postProviderSummary(req, res) {
  const payload = parse(summarySchema, req.body, "Write a summary for the provider.");
  const ticket = await support.setProviderSummary(
    req.params.id,
    payload.summary,
    req.adminUser?.userId || req.user?.userId || null,
  );
  return res.json({
    success: true,
    message: "Summary sent. The provider can now see this complaint.",
    data: ticket,
  });
}

async function postShareDecision(req, res) {
  const payload = parse(shareSchema, req.body, "Choose whether to share the original.");
  const result = await support.decideOriginalShare(req.params.id, {
    share: payload.share,
    reason: payload.reason,
    adminUserId: req.adminUser?.userId || req.user?.userId || null,
  }, req);
  return res.json({
    success: true,
    message: result.shared
      ? "The original complaint has been shared with the provider."
      : "Recorded: the original will not be shared.",
    data: result,
  });
}

module.exports = {
  getMyTickets,
  getMyTicket,
  createMyTicket,
  postMyMessage,
  postRequestOriginal,
  getTickets,
  getTicket,
  postAdminMessage,
  patchTicket,
  postProviderSummary,
  postShareDecision,
};
