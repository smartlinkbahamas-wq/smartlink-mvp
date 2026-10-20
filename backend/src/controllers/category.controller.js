const {
  listPublicCategories,
  listAdminCategories,
  listSpecializationLabels,
  createCategory,
  updateCategory,
  deleteCategory,
} = require("../services/category.service");
const { appendAdminAuditLog } = require("../services/admin-audit.service");

// Public: the quiz and the expert application both read this without a session.
async function getPublicCategories(req, res) {
  const data = await listPublicCategories();
  return res.json({ success: true, data });
}

async function getSpecializations(req, res) {
  const data = await listSpecializationLabels();
  return res.json({ success: true, data });
}

async function getAdminCategories(req, res) {
  const data = await listAdminCategories();
  return res.json({ success: true, data });
}

async function postCategory(req, res) {
  const created = await createCategory(req.body || {});

  await appendAdminAuditLog({
    req,
    actor: req.adminActor,
    actionType: "service_category_create",
    targetType: "service_category",
    targetId: created.id,
    previousValue: null,
    newValue: created,
    notes: `Created category "${created.label}".`,
  });

  return res.status(201).json({ success: true, data: created });
}

async function patchCategory(req, res) {
  const updated = await updateCategory(req.params.id, req.body || {});

  await appendAdminAuditLog({
    req,
    actor: req.adminActor,
    actionType: "service_category_update",
    targetType: "service_category",
    targetId: updated.id,
    previousValue: null,
    newValue: updated,
    notes: `Updated category "${updated.label}".`,
  });

  return res.json({ success: true, data: updated });
}

async function removeCategory(req, res) {
  const deleted = await deleteCategory(req.params.id);

  await appendAdminAuditLog({
    req,
    actor: req.adminActor,
    actionType: "service_category_delete",
    targetType: "service_category",
    targetId: deleted.id,
    previousValue: deleted,
    newValue: null,
    notes: `Deleted category "${deleted.label}".`,
  });

  return res.json({ success: true, data: { id: deleted.id } });
}

module.exports = {
  getPublicCategories,
  getSpecializations,
  getAdminCategories,
  postCategory,
  patchCategory,
  removeCategory,
};
