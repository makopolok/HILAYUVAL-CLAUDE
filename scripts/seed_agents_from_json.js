// Usage: node scripts/seed_agents_from_json.js
const fs = require('fs');
const path = require('path');
const { getPool, closePool, registerPoolShutdown, withClient } = require('../utils/database');

getPool({ ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 10000 });
registerPoolShutdown({ exitOnFinish: true });

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEntry(entry) {
  const hebrewName = (entry.value || entry.hebrew_name || '').toString().trim();
  const englishName = (entry.label || entry.english_name || '').toString().trim();
  const phone = (entry.phone || '').toString().trim() || null;
  const email = (entry.email || '').toString().trim() || null;
  const aliases = Array.from(new Set([
    ...toArray(entry.search_aliases),
    ...toArray(entry.search),
    ...toArray(entry.aliases)
  ]));

  return {
    hebrew_name: hebrewName,
    english_name: englishName,
    phone,
    email,
    search_aliases: aliases,
    active: entry.active !== false,
    contacts: Array.isArray(entry.contacts) ? entry.contacts : []
  };
}

async function seed() {
  const file = path.join(__dirname, '../data/agency-suggestions.json');
  if (!fs.existsSync(file)) {
    console.error('agency-suggestions.json not found');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const agents = raw.map(normalizeEntry).filter((agent) => agent.hebrew_name || agent.english_name);

  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      for (const agent of agents) {
        const upsertResult = await client.query(
          `
            INSERT INTO agents (hebrew_name, english_name, phone, email, search_aliases, active)
            VALUES ($1, $2, $3, $4, $5::text[], $6)
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          [agent.hebrew_name, agent.english_name, agent.phone, agent.email, agent.search_aliases, agent.active]
        );

        let agentId = upsertResult.rows[0] && upsertResult.rows[0].id;
        if (!agentId) {
          const existing = await client.query(
            `
              SELECT id
              FROM agents
              WHERE LOWER(hebrew_name) = LOWER($1)
                 OR LOWER(english_name) = LOWER($2)
              ORDER BY id ASC
              LIMIT 1
            `,
            [agent.hebrew_name, agent.english_name]
          );
          agentId = existing.rows[0] && existing.rows[0].id;
        }

        if (!agentId) {
          console.warn(`Skipped agent without database id: ${agent.hebrew_name} / ${agent.english_name}`);
          continue;
        }

        for (const contact of agent.contacts) {
          const contactName = (contact.contact_name || contact.name || '').toString().trim() || null;
          const contactPhone = (contact.phone || '').toString().trim() || null;
          const contactEmail = (contact.email || '').toString().trim() || null;
          const isPrimary = Boolean(contact.is_primary);

          if (isPrimary) {
            await client.query('UPDATE agent_contacts SET is_primary = FALSE WHERE agent_id = $1', [agentId]);
          }

          await client.query(
            `
              INSERT INTO agent_contacts (agent_id, contact_name, phone, email, is_primary)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT DO NOTHING
            `,
            [agentId, contactName, contactPhone, contactEmail, isPrimary]
          );
        }
      }

      await client.query('COMMIT');
      console.log(`Seeded ${agents.length} agent records from JSON.`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  await closePool('seed_agents_from_json:cleanup');
}

seed().catch(async (error) => {
  console.error('Agent seeding failed:', error.message);
  try {
    await closePool('seed_agents_from_json:error');
  } catch (_) {}
  process.exit(1);
});
