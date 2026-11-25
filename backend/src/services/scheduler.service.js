const os = require("os");

const { requireSupabase } = require("../utils/supabase-guard");
const { env } = require("../config/env");

/**
 * The background task runner.
 *
 * Every timed feature depends on this: quotation expiry reminders, the daily
 * lead summary, and the job monitoring schedule that comes next.
 *
 * Deliberately not a bare setInterval. Three things an in-process timer cannot
 * do, all of which this must:
 *
 * - Survive a restart. Timers lose their place on every deploy, so a daily job
 *   would silently never run on a day the server was restarted. The schedule
 *   lives in Postgres.
 *
 * - Run once across N instances. Two processes with the same timer both fire
 *   and the provider gets two copies of the same email. Each task is claimed
 *   with a conditional UPDATE, so exactly one caller wins.
 *
 * - Not flood after downtime. next_run_at advances from the moment a task
 *   finishes, not from the slot it missed, so a day offline produces one
 *   catch-up run rather than a burst.
 *
 * It is also deliberately not a cron library. A cron expression cannot express
 * "once per provider per day, whenever that provider is next due", which is
 * what the daily summary actually needs.
 */

// Identifies which process holds a task, so a stuck one can be traced to an
// instance rather than guessed at.
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;

const LOCK_TIMEOUT_SECONDS = 900;

const handlers = new Map();
let timer = null;
let running = false;
let stopping = false;
let missingTableWarned = false;

function log(message, ...rest) {
  console.log(`[scheduler] ${message}`, ...rest);
}

/**
 * Registers the function that does a task's work.
 *
 * A handler returns a short string describing what it did, which is stored on
 * the task row and surfaced by the health endpoint -- "3 reminders sent" is a
 * far more useful answer to "is the scheduler working" than "last ran at".
 */
function register(taskKey, handler) {
  handlers.set(taskKey, handler);
}

function tableIsMissing(error) {
  return (
    error?.code === "42P01" ||
    /schema cache/i.test(error?.message || "") ||
    /does not exist/i.test(error?.message || "")
  );
}

/** Attempts to take a task. Returns the row if this process won, else null. */
async function claim(taskKey) {
  const supabase = requireSupabase();
  const { data, error } = await supabase.rpc("claim_scheduled_task", {
    p_task_key: taskKey,
    p_locked_by: INSTANCE_ID,
    p_lock_timeout_seconds: LOCK_TIMEOUT_SECONDS,
  });

  if (error) {
    if (tableIsMissing(error)) {
      // Warned once, not every tick: the server runs fine without the
      // scheduler installed, and a log line per tick would bury everything
      // else.
      if (!missingTableWarned) {
        missingTableWarned = true;
        log("not installed — run sql/install_scheduler.sql. Timed features are inactive.");
      }
      return null;
    }
    log(`could not claim ${taskKey}:`, error.message);
    return null;
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function release(taskKey, status, durationMs, detail, errorMessage) {
  const supabase = requireSupabase();
  const { error } = await supabase.rpc("release_scheduled_task", {
    p_task_key: taskKey,
    p_status: status,
    p_duration_ms: durationMs,
    p_detail: detail ? String(detail).slice(0, 500) : null,
    p_error: errorMessage ? String(errorMessage).slice(0, 1000) : null,
  });

  if (error) {
    // A task that cannot be released stays locked until the timeout clears it,
    // which is the correct failure: it delays the task rather than running it
    // twice.
    log(`could not release ${taskKey}:`, error.message);
  }
}

/**
 * Runs one task if it is due and this process wins the claim.
 *
 * A handler that throws is recorded as an error and released normally. The
 * alternative -- letting it propagate -- would leave the task locked and stop
 * it running again until the lock timeout, turning one bad run into fifteen
 * minutes of silence.
 */
async function runTask(taskKey) {
  const task = await claim(taskKey);
  if (!task) return;

  const handler = handlers.get(taskKey);
  if (!handler) {
    // Registered in the database but not in code: likely a half-finished
    // deploy. Skipped rather than errored, so it does not inflate error_count.
    await release(taskKey, "skipped", 0, "No handler registered in this build.");
    return;
  }

  const startedAt = Date.now();
  try {
    const detail = await handler();
    const duration = Date.now() - startedAt;
    await release(taskKey, "ok", duration, detail || "Nothing to do.");
    if (detail) log(`${taskKey}: ${detail} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startedAt;
    log(`${taskKey} failed:`, error.message);
    await release(taskKey, "error", duration, null, error.message);
  }
}

/**
 * One pass over every registered task.
 *
 * Sequential, not parallel. These tasks send email and touch the same tables;
 * running them one at a time keeps the load predictable on a small VPS and
 * makes the logs readable.
 */
async function tick() {
  if (running || stopping) return;
  running = true;

  try {
    for (const taskKey of handlers.keys()) {
      if (stopping) break;
      await runTask(taskKey);
    }
  } catch (error) {
    // Must never throw: an unhandled rejection here would take down the API
    // process along with the scheduler.
    log("tick failed:", error.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;

  if (!env.SCHEDULER_ENABLED) {
    log("disabled by SCHEDULER_ENABLED=false. Timed features are inactive.");
    return;
  }

  const tickMs = Math.max(30, env.SCHEDULER_TICK_SECONDS) * 1000;
  log(`starting as ${INSTANCE_ID}, tick every ${tickMs / 1000}s, ${handlers.size} task(s) registered`);

  // unref() so the timer never holds the process open on shutdown.
  timer = setInterval(() => {
    tick().catch((error) => log("tick rejected:", error.message));
  }, tickMs);
  if (typeof timer.unref === "function") timer.unref();

  // First pass shortly after boot rather than immediately, so startup is not
  // competing with the API accepting its first requests.
  setTimeout(() => {
    tick().catch((error) => log("initial tick rejected:", error.message));
  }, 10_000).unref?.();
}

/**
 * Stops accepting new work.
 *
 * Does not cancel a task already running: killing one mid-send could leave
 * half a batch of emails out with nothing recorded. The lock timeout covers
 * the case where the process dies anyway.
 */
function stop() {
  stopping = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** For the health endpoint. Reads state, never schedules anything. */
async function getStatus() {
  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase
      .from("scheduled_tasks")
      .select("task_key, enabled, interval_seconds, next_run_at, last_run_at, last_status, last_detail, last_error, run_count, error_count, locked_by")
      .order("task_key");

    if (error) {
      if (tableIsMissing(error)) {
        return { installed: false, enabled: env.SCHEDULER_ENABLED, tasks: [] };
      }
      throw error;
    }

    return {
      installed: true,
      enabled: env.SCHEDULER_ENABLED,
      instance: INSTANCE_ID,
      registeredHandlers: [...handlers.keys()],
      tasks: data || [],
    };
  } catch (error) {
    return { installed: false, enabled: env.SCHEDULER_ENABLED, error: error.message, tasks: [] };
  }
}

module.exports = {
  INSTANCE_ID,
  register,
  start,
  stop,
  tick,
  runTask,
  getStatus,
};
