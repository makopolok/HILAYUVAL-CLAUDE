// Durable upload-intent store for Bunny direct uploads.
//
// This is the DB-backed replacement for the in-memory `directUploadIntentStore`
// Map in app.js. It survives dyno restarts/deploys and is shared across dynos.
//
// The intent is keyed on two stable identifiers:
//   - intent_token: opaque single-use token handed to the browser
//   - guid:         the Bunny video GUID (natural correlation id across logs)
//
// State machine (see migration 011):
//   intent_created -> token_issued -> upload_started -> uploaded -> processing -> completed
//   plus terminal/exception states: expired, failed, orphaned
const { getPool } = require('../utils/database');

const pool = getPool();

const CONSUMABLE_STATES = ['intent_created', 'token_issued', 'upload_started'];

// Coerce to a positive integer or null. Critically, Number(null) === 0 and
// Number('') === 0, so a naive Number() guard would insert 0 and violate the
// project_id foreign key. Treat null/undefined/'' as SQL NULL.
function toNullableInt(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

// Create a durable intent when direct-upload credentials are issued.
async function createIntent({ intentToken, guid, projectId, roleName, ipAddress, expiresAt }) {
  const query = `
    INSERT INTO upload_intents (intent_token, guid, project_id, role_name, ip_address, state, expires_at)
    VALUES ($1, $2, $3, $4, $5, 'token_issued', $6)
    ON CONFLICT (guid) DO UPDATE
      SET intent_token = EXCLUDED.intent_token,
          project_id = EXCLUDED.project_id,
          role_name = EXCLUDED.role_name,
          ip_address = EXCLUDED.ip_address,
          state = 'token_issued',
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
    RETURNING *;
  `;
  const values = [
    intentToken,
    guid,
    toNullableInt(projectId),
    roleName ? String(roleName) : null,
    ipAddress || null,
    expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
  ];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

// Atomically consume an intent (single-use). Returns { ok, reason, intent }.
// Validates guid/project/role/ip/expiry the same way the legacy in-memory path did.
async function consumeIntent({ intentToken, guid, projectId, roleName, ipAddress }) {
  if (!intentToken) {
    return { ok: false, reason: 'missing_intent' };
  }

  // Atomic transition: only one caller can move a consumable intent to 'uploaded'.
  const updateQuery = `
    UPDATE upload_intents
    SET state = 'uploaded', updated_at = NOW()
    WHERE intent_token = $1
      AND state = ANY($2)
      AND expires_at > NOW()
    RETURNING *;
  `;
  const { rows } = await pool.query(updateQuery, [intentToken, CONSUMABLE_STATES]);

  if (rows.length === 0) {
    // Nothing transitioned — figure out why for precise diagnostics.
    const { rows: existing } = await pool.query(
      'SELECT * FROM upload_intents WHERE intent_token = $1',
      [intentToken]
    );
    if (existing.length === 0) {
      return { ok: false, reason: 'intent_not_found' };
    }
    const record = existing[0];
    if (['uploaded', 'processing', 'completed'].includes(record.state)) {
      return { ok: false, reason: 'intent_already_used', intent: record };
    }
    if (new Date(record.expires_at).getTime() <= Date.now()) {
      return { ok: false, reason: 'intent_expired', intent: record };
    }
    return { ok: false, reason: 'intent_not_consumable', intent: record };
  }

  const record = rows[0];

  // Validate binding fields; if any mismatch, roll the state back so a correct
  // retry can still succeed (the transition was speculative).
  //
  // Note: role is intentionally NOT a hard gate. Unlike guid/token/project/ip
  // (which identify the upload), the role is a user choice that can legitimately
  // change after the video finished uploading (e.g. the actor switches the
  // dropdown before submitting). The authoritative role is stamped later in
  // markCompleted from the actually-submitted audition.
  const mismatch = (
    (record.guid && record.guid !== guid) ? 'intent_guid_mismatch' :
    (record.project_id != null && String(projectId) !== String(record.project_id)) ? 'intent_project_mismatch' :
    (record.ip_address && ipAddress && record.ip_address !== ipAddress) ? 'intent_ip_mismatch' :
    null
  );

  if (mismatch) {
    await pool.query(
      `UPDATE upload_intents SET state = 'token_issued', updated_at = NOW() WHERE id = $1`,
      [record.id]
    );
    return { ok: false, reason: mismatch, intent: record };
  }

  return { ok: true, intent: record };
}

// Mark an intent fully completed and link it to the persisted audition row.
// Also stamps the authoritative submitted role (COALESCE keeps an existing
// value if none is passed, so we never blank out a previously recorded role).
async function markCompleted({ guid, auditionId, roleName }) {
  const { rows } = await pool.query(
    `UPDATE upload_intents
     SET state = 'completed',
         audition_id = $2,
         role_name = COALESCE($3, role_name),
         updated_at = NOW()
     WHERE guid = $1
     RETURNING *;`,
    [guid, toNullableInt(auditionId), roleName ? String(roleName) : null]
  );
  return rows[0] || null;
}

// Look up an intent by Bunny GUID (used by reconciliation / debugging).
async function findByGuid(guid) {
  const { rows } = await pool.query('SELECT * FROM upload_intents WHERE guid = $1', [guid]);
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query('SELECT * FROM upload_intents WHERE id = $1', [toNullableInt(id)]);
  return rows[0] || null;
}

// Non-terminal states the reconciliation worker considers "in flight".
const NON_TERMINAL_STATES = [
  'intent_created',
  'token_issued',
  'upload_started',
  'uploaded',
  'processing',
];

// Find stale, non-terminal intents whose upload window has closed
// (expires_at in the past). Ordered oldest-first so the backlog drains fairly.
async function findStaleIntents(limit = 25) {
  const { rows } = await pool.query(
    `SELECT * FROM upload_intents
     WHERE state = ANY($1)
       AND expires_at < NOW()
     ORDER BY expires_at ASC
     LIMIT $2`,
    [NON_TERMINAL_STATES, Math.max(1, Math.min(500, Number(limit) || 25))]
  );
  return rows;
}

// Generic terminal-state transition used by the reconciliation worker.
// Only advances rows still in a non-terminal state so we never clobber a
// completed/expired/orphaned record set by a concurrent path.
async function markState({ id, state, auditionId }) {
  const { rows } = await pool.query(
    `UPDATE upload_intents
     SET state = $2,
         audition_id = COALESCE($3, audition_id),
         updated_at = NOW()
     WHERE id = $1
       AND state = ANY($4)
     RETURNING *;`,
    [id, state, toNullableInt(auditionId), NON_TERMINAL_STATES]
  );
  return rows[0] || null;
}

// Snapshot counts by state (observability for the admin endpoint).
async function countByState() {
  const { rows } = await pool.query(
    `SELECT state, COUNT(*)::int AS count
     FROM upload_intents
     GROUP BY state
     ORDER BY state`
  );
  return rows;
}

// Recent intents with their linked audition context (admin dashboard).
async function listRecent(limit = 50, offset = 0, projectId = null, mirrorFailuresOnly = false) {
  const capped = Math.max(1, Math.min(200, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const params = [capped, safeOffset];
  const whereParts = [];
  if (projectId != null && projectId !== '') {
    params.push(Number(projectId));
    whereParts.push(`ui.project_id = $${params.length}`);
  }
  if (mirrorFailuresOnly) {
    whereParts.push(`ui.state = 'completed'`);
    whereParts.push(`a.id IS NOT NULL`);
    whereParts.push(`a.video_type = 'bunny_stream'`);
    whereParts.push(`COALESCE(a.youtube_video_id, '') = ''`);
    whereParts.push(`COALESCE(a.youtube_video_url, '') = ''`);
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT ui.id, ui.guid, ui.state, ui.project_id, ui.role_name,
           ui.audition_id, ui.ip_address, ui.created_at, ui.updated_at, ui.expires_at,
           p.name AS project_name,
           a.video_type AS audition_video_type,
           a.video_url AS audition_video_url,
           a.youtube_video_id,
           a.youtube_video_url,
           a.youtube_synced_at
     FROM upload_intents ui
     LEFT JOIN projects p ON p.id = ui.project_id
     LEFT JOIN auditions a ON a.id = ui.audition_id
     ${where}
     ORDER BY ui.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );
  return rows;
}

// Count intents optionally filtered by project (for pagination).
async function countIntents(projectId = null, mirrorFailuresOnly = false) {
  const params = [];
  const whereParts = [];
  if (projectId != null && projectId !== '') {
    params.push(Number(projectId));
    whereParts.push(`ui.project_id = $${params.length}`);
  }
  if (mirrorFailuresOnly) {
    whereParts.push(`ui.state = 'completed'`);
    whereParts.push(`a.id IS NOT NULL`);
    whereParts.push(`a.video_type = 'bunny_stream'`);
    whereParts.push(`COALESCE(a.youtube_video_id, '') = ''`);
    whereParts.push(`COALESCE(a.youtube_video_url, '') = ''`);
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM upload_intents ui
     LEFT JOIN auditions a ON a.id = ui.audition_id
     ${where}`,
    params
  );
  return rows[0].total;
}

// All projects that have at least one upload intent (for filter dropdown).
async function listIntentProjects() {
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.name
     FROM upload_intents ui
     JOIN projects p ON p.id = ui.project_id
     ORDER BY p.name`
  );
  return rows;
}

module.exports = {
  createIntent,
  consumeIntent,
  markCompleted,
  findByGuid,
  findById,
  findStaleIntents,
  markState,
  countByState,
  listRecent,
  countIntents,
  listIntentProjects,
  CONSUMABLE_STATES,
  NON_TERMINAL_STATES,
};
