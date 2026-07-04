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
  const mismatch = (
    (record.guid && record.guid !== guid) ? 'intent_guid_mismatch' :
    (record.project_id != null && String(projectId) !== String(record.project_id)) ? 'intent_project_mismatch' :
    (record.role_name && String(roleName) !== String(record.role_name)) ? 'intent_role_mismatch' :
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
async function markCompleted({ guid, auditionId }) {
  const { rows } = await pool.query(
    `UPDATE upload_intents
     SET state = 'completed', audition_id = $2, updated_at = NOW()
     WHERE guid = $1
     RETURNING *;`,
    [guid, toNullableInt(auditionId)]
  );
  return rows[0] || null;
}

// Look up an intent by Bunny GUID (used by reconciliation / debugging).
async function findByGuid(guid) {
  const { rows } = await pool.query('SELECT * FROM upload_intents WHERE guid = $1', [guid]);
  return rows[0] || null;
}

module.exports = {
  createIntent,
  consumeIntent,
  markCompleted,
  findByGuid,
  CONSUMABLE_STATES,
};
