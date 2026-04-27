/**
 * lib/log.mjs — Structured logging helpers
 *
 * All log lines go to stdout/stderr and appear in Netlify → Functions → Logs.
 * Using structured JSON makes it easy to grep / filter in production.
 */

/**
 * Emit a structured JSON log line.
 *
 * @param {"info"|"warn"|"error"} level - Severity level
 * @param {string} fn      - Name of the calling function file, e.g. "meetings"
 * @param {string} message - Human-readable description
 * @param {object} [extra] - Any additional key-value pairs to include
 */
export function log(level, fn, message, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    fn,
    msg: message,
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Log an incoming HTTP request (method + path). Call once at the top of each
 * route handler so every request appears in the function logs.
 *
 * @param {string} fn  - Calling function name
 * @param {Request} req
 * @param {object} [extra]
 */
export function logRequest(fn, req, extra = {}) {
  log("info", fn, `${req.method} ${new URL(req.url).pathname}`, extra);
}
