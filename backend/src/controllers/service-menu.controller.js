const { ZodError } = require("zod");
const { AppError } = require("../utils/app-error");
const {
  createServiceMenuItemSchema,
  updateServiceMenuItemSchema,
  reorderServiceMenuSchema,
} = require("../validators/service-menu.validator");
const {
  listServiceMenu,
  listPublicServiceMenu,
  createServiceMenuItem,
  updateServiceMenuItem,
  deleteServiceMenuItem,
  reorderServiceMenu,
} = require("../services/service-menu.service");
const { resolveExpertIdForUser } = require("../utils/expert-identity");

function parseWithSchema(schema, payload, message) {
  try {
    return schema.parse(payload || {});
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError(message, 400, { code: "validation_error", fields: error.flatten() });
    }
    throw error;
  }
}

async function getMyServiceMenu(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const items = await listServiceMenu(expertId);
  return res.status(200).json({ success: true, data: { items } });
}

async function postServiceMenuItem(req, res) {
  const payload = parseWithSchema(
    createServiceMenuItemSchema,
    req.body,
    "Check the service details and try again.",
  );
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const item = await createServiceMenuItem(expertId, payload);
  return res.status(201).json({ success: true, message: "Service added.", data: item });
}

async function patchServiceMenuItem(req, res) {
  const payload = parseWithSchema(
    updateServiceMenuItemSchema,
    req.body,
    "Check the service details and try again.",
  );
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const item = await updateServiceMenuItem(expertId, req.params.id, payload);
  return res.status(200).json({ success: true, message: "Service saved.", data: item });
}

async function deleteServiceMenuItemHandler(req, res) {
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const removed = await deleteServiceMenuItem(expertId, req.params.id);
  return res.status(200).json({ success: true, message: "Service removed.", data: removed });
}

async function patchServiceMenuOrder(req, res) {
  const payload = parseWithSchema(
    reorderServiceMenuSchema,
    req.body,
    "Could not read the new order.",
  );
  const expertId = await resolveExpertIdForUser(req.user?.userId);
  const items = await reorderServiceMenu(expertId, payload.orderedIds);
  return res.status(200).json({ success: true, message: "Order saved.", data: { items } });
}

/**
 * Public: a provider's published menu, for a profile page. Active items only,
 * and no internal fields -- sort_order, is_active and the timestamps are not
 * selected at all rather than stripped afterwards.
 */
async function getPublicServiceMenu(req, res) {
  const items = await listPublicServiceMenu(req.params.expertId);
  return res.status(200).json({ success: true, data: { items } });
}

module.exports = {
  getMyServiceMenu,
  postServiceMenuItem,
  patchServiceMenuItem,
  deleteServiceMenuItemHandler,
  patchServiceMenuOrder,
  getPublicServiceMenu,
};
