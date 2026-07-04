// Reconciliation worker for Bunny direct-upload intents.
//
// Motivation (see review + migration 011): the "upload accepted" event in Bunny
// and the audition DB insert are not guaranteed to complete together. If the
// browser closes after a successful upload, or the finalize handler crashes
// between consuming the intent and saving the audition, the intent is left in a
// non-terminal state forever. This worker periodically scans stale intents
// (upload window closed) and drives each to a terminal state:
//
//   audition row exists for the GUID           -> completed (recovery)
//   no audition, but file exists in Bunny       -> orphaned  (flag for review)
//   no audition, and file not in Bunny          -> expired   (nothing to keep)
//
// Safety:
//   * Only rows past expires_at are touched, so we never race an in-flight
//     upload/finalize (expires_at is 1-2h out from issuance).
//   * A Postgres advisory lock ensures only one dyno reconciles at a time.
//   * markState only advances non-terminal rows, so concurrent finalize wins.
//   * Bunny lookups are best-effort; a transient Bunny/API error leaves the
//     intent untouched for the next pass rather than mislabelling it.

const { withClient } = require('../utils/database');
const uploadIntentService = require('./uploadIntentService');
const auditionService = require('./auditionService');
const bunnyUploadService = require('./bunnyUploadService');

// Arbitrary but stable 64-bit key for pg_try_advisory_lock. Chosen once; must
// not collide with other advisory locks in the app (none exist today).
const ADVISORY_LOCK_KEY = 447160011;

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // "every 15 is enough"
const DEFAULT_BATCH_LIMIT = 25;

let intervalHandle = null;
let running = false; // guards against overlapping passes within one dyno

function intervalMs() {
  const raw = Number(process.env.RECONCILE_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60000 ? raw : DEFAULT_INTERVAL_MS;
}

function batchLimit() {
  const raw = Number(process.env.RECONCILE_BATCH_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.min(500, raw) : DEFAULT_BATCH_LIMIT;
}

// Does a video with this GUID still exist in the Bunny library?
// Returns true/false, or null when we could not determine (transient error).
async function bunnyVideoExists(guid) {
  try {
    const status = await bunnyUploadService.getVideoStatus(guid);
    return Boolean(status && status.uid);
  } catch (err) {
    const httpStatus = err && err.response && err.response.status;
    if (httpStatus === 404) return false;
    // Network/timeout/5xx/auth: unknown. Do not mislabel.
    console.warn(`RECONCILE_BUNNY_CHECK_WARN: guid=${guid} err=${err.message} http=${httpStatus || 'n/a'}`);
    return null;
  }
}

// Resolve a single stale intent to a terminal state. Returns the outcome label.
async function reconcileIntent(intent) {
  const guid = intent.guid;

  // 1) Did the submission actually complete? An audition for this GUID means the
  //    file is stored and recorded; the intent just never got marked completed.
  let audition = null;
  try {
    audition = await auditionService.findAuditionByBunnyGuid(guid);
  } catch (err) {
    console.warn(`RECONCILE_AUDITION_LOOKUP_WARN: guid=${guid} err=${err.message}`);
    return 'skipped'; // DB hiccup; retry next pass.
  }
  if (audition) {
    await uploadIntentService.markState({ id: intent.id, state: 'completed', auditionId: audition.id });
    console.log(`RECONCILE_COMPLETED: intentId=${intent.id} guid=${guid} auditionId=${audition.id}`);
    return 'completed';
  }

  // 2) No audition. Is the file sitting in Bunny with no DB record?
  const exists = await bunnyVideoExists(guid);
  if (exists === null) {
    return 'skipped'; // couldn't reach Bunny; retry next pass.
  }
  if (exists) {
    await uploadIntentService.markState({ id: intent.id, state: 'orphaned' });
    console.warn(`RECONCILE_ORPHANED: intentId=${intent.id} guid=${guid} (file in Bunny, no audition)`);
    return 'orphaned';
  }

  // 3) No audition and no file: the upload never landed. Expire it.
  await uploadIntentService.markState({ id: intent.id, state: 'expired' });
  console.log(`RECONCILE_EXPIRED: intentId=${intent.id} guid=${guid} (no file, no audition)`);
  return 'expired';
}

// Run one reconciliation pass. Safe to call manually (admin endpoint) or on a
// timer. Uses an advisory lock so only one runner proceeds across all dynos.
async function reconcileOnce({ limit } = {}) {
  const summary = { scanned: 0, completed: 0, orphaned: 0, expired: 0, skipped: 0, locked: false };

  await withClient(async (client) => {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY]);
    if (!rows[0] || !rows[0].locked) {
      summary.locked = true; // another dyno holds the lock; skip this pass.
      return;
    }
    try {
      const stale = await uploadIntentService.findStaleIntents(limit || batchLimit());
      summary.scanned = stale.length;
      for (const intent of stale) {
        try {
          const outcome = await reconcileIntent(intent);
          if (summary[outcome] != null) summary[outcome] += 1;
        } catch (err) {
          summary.skipped += 1;
          console.error(`RECONCILE_INTENT_ERROR: intentId=${intent.id} guid=${intent.guid} err=${err.message}`);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  });

  if (summary.scanned > 0 || summary.locked === false) {
    console.log(`RECONCILE_PASS: ${JSON.stringify(summary)}`);
  }
  return summary;
}

// Timer-driven wrapper that never overlaps and never throws to the event loop.
async function tick() {
  if (running) {
    console.log('RECONCILE_SKIP_OVERLAP: previous pass still running');
    return;
  }
  running = true;
  try {
    await reconcileOnce();
  } catch (err) {
    console.error(`RECONCILE_TICK_ERROR: ${err.message}`);
  } finally {
    running = false;
  }
}

// Start the periodic worker. Disabled when RECONCILE_ENABLED=0 or in tests.
function start() {
  if (intervalHandle) return intervalHandle;
  if (process.env.RECONCILE_ENABLED === '0') {
    console.log('RECONCILE_DISABLED: RECONCILE_ENABLED=0');
    return null;
  }
  if (process.env.NODE_ENV === 'test') {
    return null;
  }
  const ms = intervalMs();
  // Kick off a delayed first pass so startup isn't blocked and Bunny/DB are warm.
  const firstDelay = Math.min(ms, 60 * 1000);
  setTimeout(() => { tick(); }, firstDelay).unref();
  intervalHandle = setInterval(() => { tick(); }, ms);
  intervalHandle.unref(); // never keep the process alive just for the timer
  console.log(`RECONCILE_STARTED: intervalMs=${ms} batchLimit=${batchLimit()} firstDelayMs=${firstDelay}`);
  return intervalHandle;
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  start,
  stop,
  tick,
  reconcileOnce,
  reconcileIntent,
  bunnyVideoExists,
};
