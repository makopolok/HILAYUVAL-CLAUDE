// One-off staging validation for the reconciliation worker (Step 3).
// Seeds three stale intents covering every terminal outcome, runs one
// reconciliation pass, asserts the resulting states, then cleans up.
//
// Usage (on a Heroku one-off dyno): node scripts/_staging_validate_reconcile.js
/* eslint-disable no-console */
const { getPool, closePool } = require('../utils/database');
const uploadIntentService = require('../services/uploadIntentService');
const reconciliationWorker = require('../services/reconciliationWorker');
const bunnyUploadService = require('../services/bunnyUploadService');

const pool = getPool();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
const uuid = () => require('crypto').randomUUID();

async function seedIntent({ token, guid, state }) {
  await pool.query(
    `INSERT INTO upload_intents (intent_token, guid, project_id, role_name, ip_address, state, expires_at)
     VALUES ($1, $2, NULL, 'ReconRole', '127.0.0.1', $3, $4)`,
    [token, guid, state, PAST]
  );
}

async function stateOf(guid) {
  const { rows } = await pool.query('SELECT state, audition_id FROM upload_intents WHERE guid = $1', [guid]);
  return rows[0] || null;
}

(async () => {
  const results = [];
  let projectId = null;
  let auditionId = null;
  let bunnyGuid = null;
  const guidCompleted = `recon-completed-${Date.now()}`;
  const guidExpired = `recon-expired-${Date.now()}`;

  try {
    // --- Outcome 1: completed (audition exists for the GUID) ---
    const p = await pool.query(`INSERT INTO projects (name) VALUES ('Recon Test Proj') RETURNING id`);
    projectId = p.rows[0].id;
    const a = await pool.query(
      `INSERT INTO auditions (project_id, role, video_url, video_type)
       VALUES ($1, 'ReconRole', $2, 'bunny_stream') RETURNING id`,
      [projectId, guidCompleted]
    );
    auditionId = a.rows[0].id;
    await seedIntent({ token: uuid(), guid: guidCompleted, state: 'uploaded' });

    // --- Outcome 2: orphaned (file exists in Bunny, no audition) ---
    // Create a real Bunny video entry (no file upload needed; it still exists).
    const created = await bunnyUploadService.createVideo('recon-orphan-test');
    bunnyGuid = created.guid;
    await seedIntent({ token: uuid(), guid: bunnyGuid, state: 'uploaded' });

    // --- Outcome 3: expired (no audition, no file in Bunny) ---
    await seedIntent({ token: uuid(), guid: guidExpired, state: 'token_issued' });

    // --- Run one reconciliation pass ---
    const summary = await reconciliationWorker.reconcileOnce({ limit: 100 });
    console.log('SUMMARY:', JSON.stringify(summary));

    // --- Assertions ---
    const sC = await stateOf(guidCompleted);
    const sO = await stateOf(bunnyGuid);
    const sE = await stateOf(guidExpired);
    console.log('completed-intent ->', JSON.stringify(sC));
    console.log('orphaned-intent  ->', JSON.stringify(sO));
    console.log('expired-intent   ->', JSON.stringify(sE));

    const checks = [
      ['completed maps to completed', sC && sC.state === 'completed'],
      ['completed links audition_id', sC && String(sC.audition_id) === String(auditionId)],
      ['bunny file maps to orphaned', sO && sO.state === 'orphaned'],
      ['no file maps to expired', sE && sE.state === 'expired'],
    ];
    let allPass = true;
    for (const [label, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
      if (!ok) allPass = false;
    }
    results.push(allPass ? 'ALL_ASSERTIONS_PASS' : 'SOME_ASSERTIONS_FAILED');
  } catch (err) {
    console.error('VALIDATION_ERROR:', err.message);
    results.push('ERROR');
  } finally {
    // --- Cleanup ---
    try {
      await pool.query(`DELETE FROM upload_intents WHERE guid = ANY($1)`, [[guidCompleted, guidExpired, bunnyGuid].filter(Boolean)]);
      if (auditionId) await pool.query(`DELETE FROM auditions WHERE id = $1`, [auditionId]);
      if (projectId) await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      if (bunnyGuid) await bunnyUploadService.deleteVideo(bunnyGuid);
      console.log('CLEANUP_DONE');
    } catch (cErr) {
      console.error('CLEANUP_WARN:', cErr.message);
    }
    await closePool('validate-reconcile');
    console.log('RESULT:', results.join(',') || 'NONE');
  }
})();
