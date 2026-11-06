const {
  listPublicCategories,
  listAdminCategories,
  listSpecializationLabels,
  createCategory,
  updateCategory,
  deleteCategory,
  createQuestion,
  updateQuestion,
  deleteQuestion,
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

async function postQuestion(req, res) {
  const created = await createQuestion(req.params.categoryId, req.body || {});

  await appendAdminAuditLog({
    req,
    actor: req.adminActor,
    actionType: "category_question_create",
    targetType: "category_question",
    targetId: created.id,
    previousValue: null,
    newValue: created,
    notes: `Added question "${created.text}".`,
  });

  return res.status(201).json({ success: true, data: created });
}

async function patchQuestion(req, res) {
  const updated = await updateQuestion(req.params.id, req.body || {});

  await appendAdminAuditLog({
    req,
    actor: req.adminActor,
    actionType: "category_question_update",
    targetType: "category_question",
    targetId: updated.id,
    previousValue: null,
    newValue: updated,
    notes: `Updated question "${updated.text}".`,
  });

  return res.json({ success: true, data: updated });
}

async function removeQuestion(req, res) {
  const deleted = await deleteQuestion(req.params.id);

  await appendAdminAuditLog({
    req,
    actor: req.adminActor,
    actionType: "category_question_delete",
    targetType: "category_question",
    targetId: deleted.id,
    previousValue: deleted,
    newValue: null,
    notes: `Deleted question "${deleted.text}".`,
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
  postQuestion,
  patchQuestion,
  removeQuestion,
};
