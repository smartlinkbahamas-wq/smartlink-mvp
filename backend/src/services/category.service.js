const { requireSupabase } = require("../utils/supabase-guard");
const { AppError } = require("../utils/app-error");

const SEGMENTS = ["business-owner", "personal-help", "not-sure"];

function toSlug(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Rows come back flat; the quiz and the admin page both want parents with
// their children attached, so assemble the tree once here.
function buildTree(rows) {
  const byId = new Map();
  rows.forEach((row) => byId.set(row.id, { ...row, children: [] }));

  const roots = [];
  byId.forEach((node) => {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node);
    } else if (!node.parent_id) {
      roots.push(node);
    }
  });

  const bySortOrder = (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label);
  roots.sort(bySortOrder);
  roots.forEach((root) => root.children.sort(bySortOrder));
  return roots;
}

async function fetchCategoryRows(includeInactive) {
  const supabase = requireSupabase();
  let query = supabase.from("service_categories").select("*");
  if (!includeInactive) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query.order("sort_order", { ascending: true });
  if (error) {
    throw new AppError("Failed to load service categories.", 500, error.message);
  }
  return data || [];
}

// Public: only active rows, and a parent that is inactive takes its children
// with it (buildTree drops orphans whose parent was filtered out).
async function listPublicCategories() {
  return buildTree(await fetchCategoryRows(false));
}

async function listAdminCategories() {
  return buildTree(await fetchCategoryRows(true));
}

// Every top-level label, used as the expert application's specialization list
// so experts and clients share one vocabulary.
async function listSpecializationLabels() {
  const rows = await fetchCategoryRows(false);
  return rows
    .filter((row) => !row.parent_id)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((row) => row.label);
}

function assertValidSegments(segments) {
  const invalid = (segments || []).filter((segment) => !SEGMENTS.includes(segment));
  if (invalid.length > 0) {
    throw new AppError(`Unknown segment: ${invalid.join(", ")}.`, 400);
  }
}

async function createCategory(payload) {
  const supabase = requireSupabase();

  const label = String(payload.label || "").trim();
  if (!label) {
    throw new AppError("A category name is required.", 400);
  }

  const parentId = payload.parentId || null;
  const segments = parentId ? [] : payload.segments || [];
  assertValidSegments(segments);

  if (!parentId && segments.length === 0) {
    throw new AppError("Choose at least one place for this category to appear.", 400);
  }

  if (parentId) {
    const { data: parent } = await supabase
      .from("service_categories")
      .select("id, parent_id")
      .eq("id", parentId)
      .maybeSingle();
    if (!parent) {
      throw new AppError("Parent category not found.", 404);
    }
    // One level of nesting keeps the quiz to a single follow-up question.
    if (parent.parent_id) {
      throw new AppError("A subcategory cannot have subcategories of its own.", 400);
    }
  }

  const slug = toSlug(payload.slug) || `need_${toSlug(label)}`;

  const row = {
    parent_id: parentId,
    slug,
    label,
    support_text: payload.supportText ? String(payload.supportText).trim() : null,
    risk_points: Number.isFinite(Number(payload.riskPoints)) ? Number(payload.riskPoints) : 4,
    segments,
    sort_order: Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 0,
    is_active: payload.isActive !== false,
  };

  const { data, error } = await supabase.from("service_categories").insert(row).select("*").single();
  if (error) {
    if (error.code === "23505") {
      throw new AppError(`A category with the key "${slug}" already exists.`, 409);
    }
    throw new AppError("Failed to create the category.", 500, error.message);
  }
  return data;
}

async function updateCategory(id, payload) {
  const supabase = requireSupabase();

  const updates = { updated_at: new Date().toISOString() };
  if (payload.label !== undefined) {
    const label = String(payload.label).trim();
    if (!label) throw new AppError("A category name is required.", 400);
    updates.label = label;
  }
  if (payload.supportText !== undefined) {
    updates.support_text = payload.supportText ? String(payload.supportText).trim() : null;
  }
  if (payload.riskPoints !== undefined) updates.risk_points = Number(payload.riskPoints) || 0;
  if (payload.sortOrder !== undefined) updates.sort_order = Number(payload.sortOrder) || 0;
  if (payload.isActive !== undefined) updates.is_active = Boolean(payload.isActive);
  if (payload.segments !== undefined) {
    assertValidSegments(payload.segments);
    updates.segments = payload.segments;
  }

  const { data, error } = await supabase
    .from("service_categories")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw new AppError("Failed to update the category.", 500, error.message);
  }
  if (!data) {
    throw new AppError("Category not found.", 404);
  }
  return data;
}

// Deleting cascades to subcategories at the database level. Leads already
// submitted keep their stored category text, so history is not rewritten.
async function deleteCategory(id) {
  const supabase = requireSupabase();
  const { data: existing } = await supabase
    .from("service_categories")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!existing) {
    throw new AppError("Category not found.", 404);
  }

  const { error } = await supabase.from("service_categories").delete().eq("id", id);
  if (error) {
    throw new AppError("Failed to delete the category.", 500, error.message);
  }
  return existing;
}

module.exports = {
  SEGMENTS,
  listPublicCategories,
  listAdminCategories,
  listSpecializationLabels,
  createCategory,
  updateCategory,
  deleteCategory,
};
