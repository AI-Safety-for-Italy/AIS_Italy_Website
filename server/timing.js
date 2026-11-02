// A Server-Timing header on the API's answers, to see in the browser's
// Network tab where a slow request spends its time:
//   total;dur=…  the whole request, in ms
//   db;dur=…     time spent waiting on the database (desc = number of queries)
//   cold         present on the first request an instance serves
// Counts only, never data.

const db = require('./db');

let warm = false;

/** Wraps a (req, res) handler so its answer carries the Server-Timing header. */
function withTiming(handler) {
  return (req, res) => {
    const stats = { queries: 0, dbMs: 0 };
    const started = performance.now();
    const cold = !warm;
    warm = true;
    const end = res.end;
    res.end = function (...args) {
      if (!res.headersSent && typeof res.setHeader === 'function') {
        const parts = [
          `total;dur=${(performance.now() - started).toFixed(1)}`,
          `db;dur=${stats.dbMs.toFixed(1)};desc="${stats.queries} queries"`,
        ];
        if (cold) parts.push('cold');
        res.setHeader('Server-Timing', parts.join(', '));
      }
      return end.apply(this, args);
    };
    return db.requestStats.run(stats, () => handler(req, res));
  };
}

module.exports = { withTiming };
