const { AppError } = require("../utils/app-error");

/**
 * A fixed-window limiter for public, unauthenticated endpoints.
 *
 * Generalised from auth-rate-limit.js, which solves the same problem but is
 * hardwired to the login route's ip::email key. That file is left alone; this
 * one is the reusable form.
 *
 * Scope, stated plainly: the counters live in this process's memory. Running
 * N instances therefore allows N times the configured rate, and a deploy
 * resets every window. That is adequate for a single-instance deployment and
 * is not a real control at scale — Postgres or Redis is the upgrade, and
 * HCAPTCHA_SECRET already exists in env.js (unused) for the step after that.
 */
function createFixedWindowLimiter({ name, windowMinutes, max, keyFn, message }) {
  if (!name) throw new Error("createFixedWindowLimiter requires a name.");

  const hits = new Map();
  const windowMs = Math.max(1, Number(windowMinutes) || 1) * 60 * 1000;
  const limit = Math.max(1, Number(max) || 1);

  const defaultKey = (req) => req.ip || req.socket?.remoteAddress || "unknown";
  const resolveKey = typeof keyFn === "function" ? keyFn : defaultKey;

  function sweep(now) {
    for (const [key, value] of hits.entries()) {
      if (now - value.windowStart > windowMs) hits.delete(key);
    }
  }

  return function fixedWindowLimiter(req, res, next) {
    const now = Date.now();
    sweep(now);

    const key = `${name}::${resolveKey(req)}`;
    const current = hits.get(key);

    if (!current || now - current.windowStart > windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return next();
    }

    if (current.count >= limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((current.windowStart + windowMs - now) / 1000),
      );
      // Retry-After is advisory but costs nothing and tells an honest client
      // when to come back. The limiter in auth-rate-limit.js omits it.
      res.set("Retry-After", String(retryAfterSeconds));
      return next(
        new AppError(message || "Too many requests. Please try again shortly.", 429, {
          code: "rate_limit_exceeded",
          retryAfterSeconds,
        }),
      );
    }

    current.count += 1;
    hits.set(key, current);
    return next();
  };
}

module.exports = {
  createFixedWindowLimiter,
};
