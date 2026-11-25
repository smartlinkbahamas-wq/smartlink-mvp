-- Run this once in the Supabase SQL editor. Safe to re-run.
-- Requires install_customers.sql and install_service_menu.sql.

-- ---------------------------------------------------------------------------
-- Working hours
-- ---------------------------------------------------------------------------
-- When a provider normally works, one row per weekday.
--
-- Stored as local date and time with no timezone, deliberately. An appointment
-- is "three o'clock on Tuesday" to both the provider and the customer; storing
-- it as an instant would shift it when daylight saving changes, and a haircut
-- booked for 3pm in November must still read 3pm in April.
create table if not exists provider_working_hours (
  expert_id text not null references experts(expert_id) on delete cascade,
  -- 0 = Sunday, matching JavaScript's getDay(), so no conversion is needed
  -- between the database and the calendar grid.
  weekday smallint not null check (weekday between 0 and 6),
  is_open boolean not null default true,
  opens_at time not null default '09:00',
  closes_at time not null default '17:00',
  updated_at timestamptz not null default now(),

  primary key (expert_id, weekday),
  constraint working_hours_order check (closes_at > opens_at)
);

-- ---------------------------------------------------------------------------
-- Blocked periods
-- ---------------------------------------------------------------------------
-- Holidays, personal time, anything that makes a provider unavailable inside
-- their normal hours.
--
-- A range rather than a flag on a day, because "unavailable Tuesday afternoon"
-- is the common case and a whole-day block is just a range that covers the
-- day.
create table if not exists availability_blocks (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,

  starts_on date not null,
  ends_on date not null,
  -- Null means the whole day. A partial block carries both times.
  starts_at time,
  ends_at time,

  reason text,
  created_at timestamptz not null default now(),

  constraint availability_blocks_date_order check (ends_on >= starts_on),
  -- Either both times are set or neither is. One alone cannot be interpreted.
  constraint availability_blocks_times_paired check (
    (starts_at is null and ends_at is null)
    or (starts_at is not null and ends_at is not null and ends_at > starts_at)
  )
);

create index if not exists idx_availability_blocks_expert
  on availability_blocks (expert_id, starts_on, ends_on);

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
-- Appointments, whether they came through SmartLink or the provider entered
-- them by hand.
--
-- Customer details are stored on the row as well as linked, for the same
-- reason quotations do: the booking is a record of what was agreed, and
-- correcting a customer's name later must not rewrite history.
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  expert_id text not null references experts(expert_id) on delete cascade,

  customer_id uuid references customers(id) on delete set null,
  customer_name text not null,
  customer_email text,
  customer_phone text,

  -- The service booked. Both are kept: the link for reporting, the name so the
  -- booking still reads correctly if the menu item is later renamed or retired.
  service_menu_item_id uuid references service_menu_items(id) on delete set null,
  service_name text,

  scheduled_on date not null,
  starts_at time not null,
  duration_minutes integer not null default 60 check (duration_minutes > 0),

  -- Exactly the four states specified.
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'completed', 'cancelled')),

  -- Recorded at creation and never changed, as everywhere else.
  source text not null default 'manual' check (source in ('smartlink', 'manual')),

  -- Where this booking came from or led to, when it is part of a larger flow.
  lead_id uuid references lead_submissions(id) on delete set null,
  job_id uuid references jobs(id) on delete set null,

  notes text,
  -- Set when the scheduler has sent the appointment reminder, so a provider is
  -- not reminded about the same appointment every tick.
  reminder_sent_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bookings_customer_name_not_blank check (length(btrim(customer_name)) > 0)
);

-- The calendar's only real query: "everything for this provider in this date
-- range". Ordered by time so the grid needs no sort.
create index if not exists idx_bookings_expert_date
  on bookings (expert_id, scheduled_on, starts_at);

-- Drives the reminder task: upcoming appointments not yet reminded about.
create index if not exists idx_bookings_reminder
  on bookings (scheduled_on)
  where status in ('pending', 'confirmed') and reminder_sent_at is null;

create index if not exists idx_bookings_customer
  on bookings (customer_id)
  where customer_id is not null;

-- ---------------------------------------------------------------------------
-- Appointment reminders
-- ---------------------------------------------------------------------------
-- Registered here rather than in code, like the other scheduled tasks, so an
-- administrator can disable it without a deploy. Hourly: a reminder for
-- tomorrow should go out within the hour, not at an arbitrary time of day.
insert into scheduled_tasks (task_key, interval_seconds) values
  ('appointment_reminders', 3600)
on conflict (task_key) do nothing;

-- ---------------------------------------------------------------------------
-- Default working hours for existing providers
-- ---------------------------------------------------------------------------
-- Monday to Friday, 9 to 5, closed at weekends. Seeded so the calendar has
-- something sensible to draw on day one rather than showing a provider no
-- available time at all until they configure it.
--
-- Idempotent, and it never overwrites hours a provider has already set.
insert into provider_working_hours (expert_id, weekday, is_open, opens_at, closes_at)
select e.expert_id,
       d.weekday,
       d.weekday between 1 and 5,
       '09:00'::time,
       '17:00'::time
from experts e
cross join (select generate_series(0, 6) as weekday) d
on conflict (expert_id, weekday) do nothing;
