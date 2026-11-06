-- Run this once in the Supabase SQL editor, after install_service_categories.sql.
-- Safe to re-run.

-- Diagnostic questions asked after a client picks a category. Options live in
-- JSONB because they are always created, reordered and deleted together with
-- their question and have no identity of their own.
-- Each option is { "id": "...", "label": "...", "support": "...", "riskPoints": 4 }.
create table if not exists category_questions (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references service_categories(id) on delete cascade,
  slug text not null unique,
  text text not null,
  helper text,
  options jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists category_questions_category_idx on category_questions(category_id);
create index if not exists category_questions_active_idx on category_questions(is_active);
