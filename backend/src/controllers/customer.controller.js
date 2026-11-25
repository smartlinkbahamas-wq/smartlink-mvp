const { ZodError } = require("zod");
const { z } = require("zod");

const { AppError } = require("../utils/app-error");
const { resolveExpertIdForUser } = require("../utils/expert-identity");
const customers = require("../services/customer.service");

/**
 * Customer records, provider-facing.
 *
 * The schemas live here rather than in business.validator.js because they are
 * small and belong to one resource; splitting them out would mean two files to
 * read for one endpoint.
 */

const customerSchema = z.object({
  fullName: z.string().trim().min(1, "Enter the customer's name.").max(200),
  // Optional: a provider may add a walk-in they only have a phone number for.
  email: z.string().trim().email("Enter a valid email address.").max(320).optional().or(z.literal("")),
  phone: z.string().trim().max(60).optional().or(z.literal("")),
  notes: z.string().trim().max(4000).optional().or(z.literal("")),
  isArchived: z.boolean().optional(),
});

const mergeSchema = z.object({
  keepId: z.string().uuid(),
  mergeId: z.string().uuid(),
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

async function listCustomers(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const rows = await customers.listCustomers(expertId, {
    includeArchived: req.query?.includeArchived === "true",
    search: req.query?.search ? String(req.query.search) : null,
  });
  return res.json({ success: true, data: { customers: rows } });
}

async function getCustomer(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const customer = await customers.getCustomer(expertId, req.params.id);
  const history = await customers.getCustomerHistory(expertId, req.params.id);
  return res.json({ success: true, data: { customer, history } });
}

async function createCustomer(req, res) {
  const payload = parse(customerSchema, req.body, "Check the customer details.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const customer = await customers.createCustomer(expertId, payload);
  return res.status(201).json({ success: true, message: "Customer added.", data: customer });
}

async function updateCustomer(req, res) {
  const payload = parse(customerSchema, req.body, "Check the customer details.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const customer = await customers.updateCustomer(expertId, req.params.id, payload);
  return res.json({ success: true, message: "Customer saved.", data: customer });
}

async function archiveCustomer(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const archived = req.body?.archived !== false;
  const customer = await customers.archiveCustomer(expertId, req.params.id, archived);
  return res.json({
    success: true,
    message: archived ? "Customer archived." : "Customer restored.",
    data: customer,
  });
}

async function mergeCustomers(req, res) {
  const payload = parse(mergeSchema, req.body, "Choose which customer to keep.");
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const customer = await customers.mergeCustomers(expertId, payload.keepId, payload.mergeId);
  return res.json({ success: true, message: "Customers merged.", data: customer });
}

module.exports = {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  archiveCustomer,
  mergeCustomers,
};
