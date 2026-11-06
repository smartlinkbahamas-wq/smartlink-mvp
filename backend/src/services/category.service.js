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
  const [rows, questions] = await Promise.all([fetchCategoryRows(false), fetchQuestionRows(false)]);
  return attachQuestions(buildTree(rows), questions);
}

async function listAdminCategories() {
  const [rows, questions] = await Promise.all([fetchCategoryRows(true), fetchQuestionRows(true)]);
  return attachQuestions(buildTree(rows), questions);
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


function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option, index) => {
      const label = String(option?.label || "").trim();
      if (!label) return null;
      return {
        id: toSlug(option?.id) || `opt_${toSlug(label)}`,
        label,
        support: option?.support ? String(option.support).trim() : "",
        riskPoints: Number.isFinite(Number(option?.riskPoints)) ? Number(option.riskPoints) : 4,
        sortOrder: index,
      };
    })
    .filter(Boolean);
}

async function fetchQuestionRows(includeInactive) {
  const supabase = requireSupabase();
  let query = supabase.from("category_questions").select("*");
  if (!includeInactive) {
    query = query.eq("is_active", true);
  }
  const { data, error } = await query.order("sort_order", { ascending: true });
  if (error) {
    // The table is optional until the migration is applied; an unconfigured
    // install should still serve categories rather than fail the quiz.
    if (error.code === "42P01" || /schema cache/i.test(error.message || "")) return [];
    throw new AppError("Failed to load category questions.", 500, error.message);
  }
  return data || [];
}

function attachQuestions(tree, questionRows) {
  const byCategory = new Map();
  questionRows.forEach((row) => {
    if (!byCategory.has(row.category_id)) byCategory.set(row.category_id, []);
    byCategory.get(row.category_id).push(row);
  });

  const walk = (nodes) =>
    nodes.map((node) => ({
      ...node,
      questions: (byCategory.get(node.id) || []).sort((a, b) => a.sort_order - b.sort_order),
      children: walk(node.children || []),
    }));

  return walk(tree);
}

async function createQuestion(categoryId, payload) {
  const supabase = requireSupabase();

  const text = String(payload.text || "").trim();
  if (!text) {
    throw new AppError("A question is required.", 400);
  }

  const options = normalizeOptions(payload.options);
  if (options.length < 2) {
    throw new AppError("Add at least two answers for this question.", 400);
  }

  const { data: category } = await supabase
    .from("service_categories")
    .select("id")
    .eq("id", categoryId)
    .maybeSingle();
  if (!category) {
    throw new AppError("Category not found.", 404);
  }

  const row = {
    category_id: categoryId,
    slug: toSlug(payload.slug) || `q_${toSlug(text).slice(0, 40)}_${Date.now().toString(36)}`,
    text,
    helper: payload.helper ? String(payload.helper).trim() : null,
    options,
    sort_order: Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 0,
    is_active: payload.isActive !== false,
  };

  const { data, error } = await supabase.from("category_questions").insert(row).select("*").single();
  if (error) {
    if (error.code === "23505") {
      throw new AppError(`A question with the key "${row.slug}" already exists.`, 409);
    }
    throw new AppError("Failed to create the question.", 500, error.message);
  }
  return data;
}

async function updateQuestion(id, payload) {
  const supabase = requireSupabase();
  const updates = { updated_at: new Date().toISOString() };

  if (payload.text !== undefined) {
    const text = String(payload.text).trim();
    if (!text) throw new AppError("A question is required.", 400);
    updates.text = text;
  }
  if (payload.helper !== undefined) {
    updates.helper = payload.helper ? String(payload.helper).trim() : null;
  }
  if (payload.options !== undefined) {
    const options = normalizeOptions(payload.options);
    if (options.length < 2) {
      throw new AppError("Add at least two answers for this question.", 400);
    }
    updates.options = options;
  }
  if (payload.sortOrder !== undefined) updates.sort_order = Number(payload.sortOrder) || 0;
  if (payload.isActive !== undefined) updates.is_active = Boolean(payload.isActive);

  const { data, error } = await supabase
    .from("category_questions")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    throw new AppError("Failed to update the question.", 500, error.message);
  }
  if (!data) {
    throw new AppError("Question not found.", 404);
  }
  return data;
}

async function deleteQuestion(id) {
  const supabase = requireSupabase();
  const { data: existing } = await supabase
    .from("category_questions")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!existing) {
    throw new AppError("Question not found.", 404);
  }

  const { error } = await supabase.from("category_questions").delete().eq("id", id);
  if (error) {
    throw new AppError("Failed to delete the question.", 500, error.message);
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
  createQuestion,
  updateQuestion,
  deleteQuestion,
};
