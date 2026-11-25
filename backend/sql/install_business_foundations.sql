-- Run this once in the Supabase SQL editor. Safe to re-run.
--
-- The three foundations every priced feature in Priority 2 depends on:
--   1. Business identity on the provider  (who the document is from)
--   2. Gap-free document numbering        (what the document is called)
--   3. Secure customer links              (how the customer sees it)
--
-- Run this before install_quotations.sql and install_invoices.sql.

-- ---------------------------------------------------------------------------
-- 1. Business identity
-- ---------------------------------------------------------------------------
-- A quotation or invoice has to say who issued it. None of this existed on
-- experts, so every customer document would otherwise have gone out with only
-- a display name on it.
--
-- VAT is the part that matters legally: only a provider who is actually
-- registered may charge it, and the registration number has to appear on the
-- document.
alter table experts add column if not exists logo_url text;
alter table experts add column if not exists business_name text;
alter table experts add column if not exists business_address text;
alter table experts add column if not exists business_phone text;
alter table experts add column if not exists business_email text;
alter table experts add column if not exists website_url text;
alter table experts add column if not exists vat_registered boolean not null default false;
alter table experts add column if not exists vat_number text;

-- Claiming registration without a number is the state that would put an
-- unlawful tax line on a customer document, so the database refuses it.
-- Written as a DO block because `add constraint if not exists` does not exist.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'experts_vat_number_present_when_registered'
  ) then
    alter table experts add constraint experts_vat_number_present_when_registered
      check (vat_registered = false or (vat_number is not null and length(btrim(vat_number)) > 0));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Document numbering
-- ---------------------------------------------------------------------------
-- Quotation and invoice numbers, per provider, gap-free.
--
-- Generated in Postgres rather than in the application. Two requests arriving
-- together in Node would read the same "highest number so far" and both
-- produce QUO-0007; the customer then has two different documents with one
-- number on them. The UPDATE below takes a row lock, so concurrent callers
-- serialise and each gets its own number.
--
-- Per provider, not global: a provider's quotations should read 1, 2, 3, not
-- jump because another business on the platform issued one in between.
create table if not exists document_number_counters (
  expert_id text not null references experts(expert_id) on delete cascade,
  doc_type text not null check (doc_type in ('quotation', 'invoice', 'job')),
  next_number integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (expert_id, doc_type)
);

create or replace function next_document_number(p_expert_id text, p_doc_type text)
returns integer
language plpgsql
as $$
declare
  v_number integer;
begin
  -- Create the counter on first use. Concurrent first calls race here, which
  -- the conflict clause absorbs; the UPDATE below is what actually allocates.
  insert into document_number_counters (expert_id, doc_type)
  values (p_expert_id, p_doc_type)
  on conflict (expert_id, doc_type) do nothing;

  -- Row-locked by Postgres for the duration of the transaction, so two callers
  -- cannot be handed the same value.
  update document_number_counters
  set next_number = next_number + 1,
      updated_at = now()
  where expert_id = p_expert_id and doc_type = p_doc_type
  returning next_number - 1 into v_number;

  return v_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Secure customer links
-- ---------------------------------------------------------------------------
-- Generalises the working review_tokens pattern: a hashed single-purpose token
-- with an expiry, so a customer can approve a quotation, confirm completion,
-- answer a survey or view an invoice without holding an account.
--
-- The token is stored hashed. A leak of this table must not hand anyone the
-- ability to approve a quotation on a customer's behalf.
--
-- code_hash is on the same row rather than in a second table: a link and the
-- verification code emailed alongside it are one thing, and splitting them
-- would allow a code with no link.
create table if not exists secure_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,

  purpose text not null check (purpose in (
    'quotation_approval',
    'invoice_view',
    'completion_confirmation',
    'survey'
  )),

  -- Open text rather than a foreign key: one table serves quotations,
  -- invoices and jobs, and a column per subject would be mostly nulls.
  subject_type text not null,
  subject_id uuid not null,

  expert_id text references experts(expert_id) on delete cascade,
  recipient_email text,

  -- Set when the action requires the emailed 6-digit code as well as the link.
  -- Null means the link alone is sufficient, which is the case for surveys.
  code_hash text,
  code_expires_at timestamptz,
  code_attempts integer not null default 0,
  code_max_attempts integer not null default 5,
  code_verified_at timestamptz,

  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_secure_links_subject
  on secure_links (subject_type, subject_id, purpose);
create index if not exists idx_secure_links_expiry
  on secure_links (expires_at)
  where used_at is null and revoked_at is null;

-- Who opened the link and when.
--
-- A separate table rather than a counter on the row, because the question that
-- gets asked in a dispute is "did the customer ever see this", and a count of
-- 3 with no timestamps does not answer it.
create table if not exists secure_link_access (
  id uuid primary key default gen_random_uuid(),
  secure_link_id uuid not null references secure_links(id) on delete cascade,
  -- 'viewed' | 'code_sent' | 'code_failed' | 'code_verified' | 'actioned'
  event text not null,
  ip text,
  user_agent text,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists idx_secure_link_access_link
  on secure_link_access (secure_link_id, created_at desc);
