// services/auditionService.js
const { getPool, withClient, checkConnection } = require('../utils/database');

const pool = getPool();

// Optional: basic connectivity check helper (used by app.js /health route)
async function checkDbConnection() {
  return checkConnection();
}

const NAME_SEARCH_SQL = `COALESCE(
  TRIM(
    REGEXP_REPLACE(
      CONCAT_WS(' ',
        NULLIF(BTRIM(a.search_full_name), ''),
        NULLIF(BTRIM(a.first_name_en), ''),
        NULLIF(BTRIM(a.last_name_en), ''),
        NULLIF(BTRIM(a.first_name_he), ''),
        NULLIF(BTRIM(a.last_name_he), ''),
        NULLIF(BTRIM(a.role_locked_name), ''),
        NULLIF(BTRIM(a.role), '')
      ),
      '\\s+',
      ' ',
      'g'
    )
  ),
  ''
)`;
const ALLOWED_TAG_COLORS = new Set(['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple']);

function isTransientDbError(error) {
  if (!error) return false;
  const message = (error.message || '').toLowerCase();
  return (
    message.includes('connection terminated') ||
    message.includes('connection timeout') ||
    message.includes('terminating connection') ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNRESET' ||
    error.code === '57P01'
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryWithRetry(sql, params, label, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await pool.query(sql, params);
    } catch (error) {
      console.error(`${label}_DB_ERROR: attempt ${attempt + 1}/${maxRetries + 1}`, error);
      if (!isTransientDbError(error) || attempt >= maxRetries) {
        throw error;
      }
      const waitMs = 300 * Math.pow(2, attempt);
      console.warn(`${label}_RETRY: retrying in ${waitMs}ms due to transient DB error.`);
      await sleep(waitMs);
    }
  }
  throw new Error(`${label}_UNEXPECTED_RETRY_EXIT`);
}

async function insertAudition(audition) {
  const profilePictures = Array.isArray(audition.profile_pictures)
    ? audition.profile_pictures
    : (audition.profile_pictures || []);
  const ageVal = audition.age ? parseInt(audition.age, 10) : null;
  const heightVal = audition.height ? parseInt(audition.height, 10) : null;

  return withClient(async (client) => {
    try {
      await client.query('BEGIN');

      const insertAuditionQuery = `
        INSERT INTO auditions (
          project_id, role_id, role,
          first_name_he, last_name_he,
          first_name_en, last_name_en,
          age, height,
          current_location, about_me,
          profile_pictures, showreel_url, video_url, video_type,
          agent_id, agent_text
        ) VALUES (
          $1, $2, $3,
          $4, $5,
          $6, $7,
          $8, $9,
          $10, $11,
          $12::jsonb, $13, $14, $15,
          $16, $17
        )
        RETURNING *;
      `;

      const auditionValues = [
        audition.project_id,
        audition.role_id || null,
        audition.role,
        audition.first_name_he,
        audition.last_name_he,
        audition.first_name_en,
        audition.last_name_en,
        ageVal,
        heightVal,
        audition.current_location,
        audition.about_me,
        JSON.stringify(profilePictures),
        audition.showreel_url,
        audition.video_url,
        audition.video_type,
        audition.agent_id || null,
        audition.agent_text || audition.agency || null
      ];

      const insertedAudition = await client.query(insertAuditionQuery, auditionValues);
      const row = insertedAudition.rows[0];

      await client.query(
        `INSERT INTO audition_contacts (audition_id, email, phone, agency)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (audition_id) DO UPDATE
         SET email = EXCLUDED.email,
             phone = EXCLUDED.phone,
             agency = EXCLUDED.agency,
             updated_at = NOW()`,
        [row.id, audition.email, audition.phone, audition.agency]
      );

      await client.query('COMMIT');
      return {
        ...row,
        email: audition.email,
        phone: audition.phone,
        agency: audition.agency,
        agent_id: audition.agent_id || null,
        agent_text: audition.agent_text || audition.agency || null
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

function applyNameFilters(tokens, params, clauses) {
  tokens.forEach((token) => {
    params.push(`%${token.toLowerCase()}%`);
    clauses.push(`LOWER(${NAME_SEARCH_SQL}) LIKE $${params.length}`);
  });
}

async function getAuditionById(auditionId) {
  const sql = `
    SELECT a.*, ac.email, ac.phone, ac.agency,
           p.name AS project_name,
           r.name AS role_name
    FROM auditions a
    JOIN projects p ON p.id = a.project_id
    LEFT JOIN audition_contacts ac ON ac.audition_id = a.id
    LEFT JOIN roles r ON r.id = a.role_id
    WHERE a.id = $1
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [auditionId]);
  return rows[0] || null;
}

async function updateAuditionYoutubeData(auditionId, { youtubeVideoId, youtubeVideoUrl }) {
  const sql = `
    UPDATE auditions
    SET youtube_video_id = $2,
        youtube_video_url = $3,
        youtube_synced_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
  `;
  await pool.query(sql, [auditionId, youtubeVideoId || null, youtubeVideoUrl || null]);
}

// Promote a Bunny audition to YouTube as the primary source after successful mirroring.
// Keeps youtube_* metadata in sync and flips video_type/video_url for playback.
async function markAuditionYoutubePrimary(auditionId, { youtubeVideoId, youtubeVideoUrl }) {
  const sql = `
    UPDATE auditions
    SET video_type = 'youtube',
        video_url = $2,
        youtube_video_id = $3,
        youtube_video_url = $2,
        youtube_synced_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
  `;
  await pool.query(sql, [auditionId, youtubeVideoUrl || null, youtubeVideoId || null]);
}

// Idempotent-finalize helper: find an existing audition by its Bunny video GUID.
// Used to detect duplicate/retried submissions so we return the already-saved
// audition instead of creating a duplicate row or erroring out.
async function findAuditionByBunnyGuid(guid) {
  if (!guid) return null;
  const { rows } = await pool.query(
    `SELECT a.*, ac.email, ac.phone, ac.agency
     FROM auditions a
     LEFT JOIN audition_contacts ac ON ac.audition_id = a.id
     WHERE a.video_url = $1 AND a.video_type = 'bunny_stream'
     ORDER BY a.id DESC
     LIMIT 1`,
    [guid]
  );
  return rows[0] || null;
}

// Fetch auditions for a given project with optional filters
async function getAuditionsByProjectId(projectId, query = {}) {
  const where = ['a.project_id = $1'];
  const params = [projectId];

  if (query.role) {
    params.push(query.role);
    where.push(`a.role = $${params.length}`);
  }

  if (query.role_id) {
    params.push(parseInt(query.role_id, 10));
    where.push(`a.role_id = $${params.length}`);
  }

  if (query.email) {
    params.push(`%${query.email}%`);
    where.push(`ac.email ILIKE $${params.length}`);
  }

  const nameTokens = (query.name || '')
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (nameTokens.length > 0) {
    applyNameFilters(nameTokens, params, where);
  }

  const sql = `
    SELECT a.*, ac.email, ac.phone, ac.agency, r.name AS role_name
    FROM auditions a
    LEFT JOIN audition_contacts ac ON ac.audition_id = a.id
    LEFT JOIN roles r ON r.id = a.role_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.created_at DESC
  `;
  const { rows } = await queryWithRetry(sql, params, 'AUDITION_SERVICE_GET_BY_PROJECT');
  return rows;
}

async function getRoleAuditionCountsByProjectId(projectId, previousAdminLoginTime = null) {
  const hasPreviousLogin = previousAdminLoginTime instanceof Date
    && !Number.isNaN(previousAdminLoginTime.getTime());

  const sql = hasPreviousLogin
    ? `
      SELECT
        a.role_id,
        a.role,
        COUNT(*)::int AS total_auditions,
        COUNT(*) FILTER (WHERE a.created_at > $2)::int AS new_since_last_session
      FROM auditions a
      WHERE a.project_id = $1
      GROUP BY a.role_id, a.role
    `
    : `
      SELECT
        a.role_id,
        a.role,
        COUNT(*)::int AS total_auditions,
        0::int AS new_since_last_session
      FROM auditions a
      WHERE a.project_id = $1
      GROUP BY a.role_id, a.role
    `;

  const params = hasPreviousLogin
    ? [projectId, previousAdminLoginTime.toISOString()]
    : [projectId];
  const { rows } = await queryWithRetry(sql, params, 'AUDITION_SERVICE_GET_ROLE_COUNTS');
  return rows;
}

async function searchAuditions(filters = {}) {
  const name = (filters.name || '').toString().trim();
  const email = (filters.email || '').toString().trim();

  if (!name && !email) {
    return [];
  }

  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 25, 1), 200);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const whereClauses = [];
  const params = [];

  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    applyNameFilters(tokens, params, whereClauses);
  }

  if (email) {
    params.push(`%${email.toLowerCase()}%`);
    whereClauses.push(`LOWER(ac.email) LIKE $${params.length}`);
  }

  if (whereClauses.length === 0) {
    // Should not happen because we guard above, but keep safety net intact.
    return [];
  }

  const baseSql = `
    SELECT a.*, p.name AS project_name,
           ac.email, ac.phone, ac.agency,
           r.name AS role_name,
           ${NAME_SEARCH_SQL} AS search_name_expr
    FROM auditions a
    JOIN projects p ON p.id = a.project_id
    LEFT JOIN audition_contacts ac ON ac.audition_id = a.id
    LEFT JOIN roles r ON r.id = a.role_id
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY a.created_at DESC
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;

  params.push(limit, offset);
  const { rows } = await pool.query(baseSql, params);
  return rows;
}

async function updateAuditionTagColor(projectId, auditionId, tagColor) {
  const normalized = (tagColor || '').toString().trim().toLowerCase();
  const value = normalized ? normalized : null;
  if (value && !ALLOWED_TAG_COLORS.has(value)) {
    return { ok: false, reason: 'invalid_color' };
  }

  const sql = `
    UPDATE auditions
    SET tag_color = $3,
        updated_at = NOW()
    WHERE id = $1
      AND project_id = $2
    RETURNING id, project_id, tag_color
  `;
  const { rows } = await pool.query(sql, [auditionId, projectId, value]);
  if (!rows[0]) {
    return { ok: false, reason: 'not_found' };
  }
  return { ok: true, row: rows[0] };
}

async function deleteAudition(projectId, auditionId) {
  const sql = `
    DELETE FROM auditions
    WHERE id = $1 AND project_id = $2
    RETURNING id
  `;
  const { rows } = await pool.query(sql, [auditionId, projectId]);
  return rows.length > 0;
}

async function updateAudition(auditionId, updates) {
  // Build dynamic UPDATE query
  const setClauses = [];
  const params = [auditionId];
  let paramCount = 2;

  // Map of field names to column names (handle both auditions table and audition_contacts table)
  const fieldMapping = {
    first_name_en: { table: 'auditions', column: 'first_name_en' },
    last_name_en: { table: 'auditions', column: 'last_name_en' },
    first_name_he: { table: 'auditions', column: 'first_name_he' },
    last_name_he: { table: 'auditions', column: 'last_name_he' },
    age: { table: 'auditions', column: 'age' },
    height: { table: 'auditions', column: 'height' },
    current_location: { table: 'auditions', column: 'current_location' },
    about_me: { table: 'auditions', column: 'about_me' },
    video_url: { table: 'auditions', column: 'video_url' },
    video_type: { table: 'auditions', column: 'video_type' },
    youtube_video_url: { table: 'auditions', column: 'youtube_video_url' },
    youtube_watch_url: { table: 'auditions', column: 'youtube_watch_url' },
    email: { table: 'audition_contacts', column: 'email' },
    phone: { table: 'audition_contacts', column: 'phone' },
    agency: { table: 'audition_contacts', column: 'agency' }
  };

  // Separate updates by table
  const auditionUpdates = {};
  const contactUpdates = {};

  for (const [field, value] of Object.entries(updates)) {
    if (fieldMapping[field]) {
      if (fieldMapping[field].table === 'auditions') {
        auditionUpdates[fieldMapping[field].column] = value;
      } else {
        contactUpdates[fieldMapping[field].column] = value;
      }
    }
  }

  // Update auditions table if there are updates
  if (Object.keys(auditionUpdates).length > 0) {
    const setClauses = Object.entries(auditionUpdates).map(([column, value]) => {
      params.push(value);
      return `${column} = $${paramCount++}`;
    });
     
    const sql = `
      UPDATE auditions
      SET ${setClauses.join(', ')},
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
     
    try {
      const { rows } = await pool.query(sql, params);
      if (!rows[0]) {
        return { ok: false, error: 'Audition not found.' };
      }
    } catch (error) {
      console.error('Error updating audition:', error);
      return { ok: false, error: 'Failed to update audition data.' };
    }
  }

  // Update or insert audition_contacts if there are contact updates
  if (Object.keys(contactUpdates).length > 0) {
    const contactParams = [auditionId, ...Object.values(contactUpdates)];
    const setContactClauses = Object.entries(contactUpdates).map(([column], i) => {
      return `${column} = $${i + 2}`;
    });
    
    const sql = `
      INSERT INTO audition_contacts (audition_id, ${Object.keys(contactUpdates).join(', ')})
      VALUES ($1, ${Object.keys(contactUpdates).map((_, i) => `$${i + 2}`).join(', ')})
      ON CONFLICT (audition_id) DO UPDATE SET
        ${setContactClauses.join(', ')}
      RETURNING *
    `;
    
    try {
      const { rows } = await pool.query(sql, contactParams);
      if (!rows[0]) {
        return { ok: false, error: 'Failed to update contact data.' };
      }
    } catch (error) {
      console.error('Error updating audition contacts:', error);
      return { ok: false, error: 'Failed to update contact data.' };
    }
  }

  // Fetch and return the updated audition
  const audition = await getAuditionById(auditionId);
  return { ok: true, row: audition };
}

module.exports = {
  insertAudition,
  pool,
  checkDbConnection,
  getAuditionsByProjectId,
  getRoleAuditionCountsByProjectId,
  searchAuditions,
  getAuditionById,
  deleteAudition,
  updateAuditionYoutubeData,
  markAuditionYoutubePrimary,
  findAuditionByBunnyGuid,
  updateAuditionTagColor,
  updateAudition,
};
