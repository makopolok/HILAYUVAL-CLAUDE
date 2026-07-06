const express = require('express');
const nodemailer = require('nodemailer');
const { getPool } = require('../utils/database');
const { requireAdmin } = require('../middleware/auth');
const { getProjectById } = require('../services/projectService');

const router = express.Router();
const dbPool = getPool();

function parseBulkRequestLine(line) {
  const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return {
    agencyName: parts[0],
    actorName: parts[1],
    roleName: parts[2] || null,
    note: parts[3] || null,
  };
}

function normalizeMatchText(value) {
  return (value || '')
    .toString()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeMatchText(value) {
  return normalizeMatchText(value).split(' ').filter(Boolean);
}

function buildAgentSearchTerms(agent) {
  const terms = new Set([
    agent.hebrew_name,
    agent.english_name,
    ...(Array.isArray(agent.search_aliases) ? agent.search_aliases : []),
  ]);
  return Array.from(terms).filter(Boolean).map(normalizeMatchText);
}

function scoreAgentMatch(query, agent) {
  const normalizedQuery = normalizeMatchText(query);
  if (!normalizedQuery) return 0;
  const queryTokens = tokenizeMatchText(normalizedQuery);
  const terms = buildAgentSearchTerms(agent);

  let score = 0;
  terms.forEach((term) => {
    if (!term) return;
    if (term === normalizedQuery) score = Math.max(score, 100);
    if (term.includes(normalizedQuery)) score = Math.max(score, 90);
    if (normalizedQuery.includes(term)) score = Math.max(score, 85);

    const termTokens = tokenizeMatchText(term);
    const overlap = termTokens.filter((token) => queryTokens.includes(token)).length;
    if (overlap > 0) {
      const tokenScore = Math.round((overlap / Math.max(termTokens.length, queryTokens.length)) * 70);
      score = Math.max(score, tokenScore);
    }
  });

  return score;
}

function scoreAgentContactMatch(query, agent) {
  const normalizedQuery = normalizeMatchText(query);
  if (!normalizedQuery) return 0;
  const contactTerms = [agent.contact_name, agent.phone, agent.email].filter(Boolean).map(normalizeMatchText);
  let score = 0;
  contactTerms.forEach((term) => {
    if (!term) return;
    if (term === normalizedQuery) score = Math.max(score, 100);
    if (term.includes(normalizedQuery)) score = Math.max(score, 90);
    if (normalizedQuery.includes(term)) score = Math.max(score, 80);
  });
  return score;
}

router.get('/agents', requireAdmin, async (req, res) => {
  try {
    const { rows } = await dbPool.query(`
      SELECT a.*, COUNT(au.id)::int AS audition_count
      FROM agents a
      LEFT JOIN auditions au ON au.agent_id = a.id
      GROUP BY a.id
      ORDER BY a.active DESC, a.hebrew_name ASC
    `);
    const contactsResult = await dbPool.query(`
      SELECT id, agent_id, contact_name, phone, email, is_primary
      FROM agent_contacts
      ORDER BY is_primary DESC, contact_name ASC, id ASC
    `);
    const contactsByAgent = new Map();
    contactsResult.rows.forEach((contact) => {
      if (!contactsByAgent.has(contact.agent_id)) contactsByAgent.set(contact.agent_id, []);
      contactsByAgent.get(contact.agent_id).push(contact);
    });
    const agents = rows.map((row) => ({
      ...row,
      search_aliases: Array.isArray(row.search_aliases) ? row.search_aliases.join(', ') : (row.search_aliases || ''),
      contacts: contactsByAgent.get(row.id) || []
    }));
    res.render('admin/agents', {
      title: 'Agents',
      agents,
      agentFilters: {
        query: (req.query.q || '').toString().trim(),
        status: (req.query.status || 'all').toString(),
      },
      breadcrumbTrail: [
        { label: 'Home', url: '/' },
        { label: 'Admin', url: '/admin/login' },
        { label: 'Agents', url: '/admin/agents' },
      ],
    });
  } catch (error) {
    console.error('[ADMIN_AGENTS_LOAD_ERROR]', error);
    res.status(500).send('Could not load agents right now.');
  }
});

router.get('/agents/audit', requireAdmin, async (req, res) => {
  try {
    const projectRows = await dbPool.query(`
      SELECT p.id, p.name, COUNT(a.id)::int AS audition_count, COUNT(DISTINCT a.agent_id)::int AS linked_agents
      FROM projects p
      LEFT JOIN auditions a ON a.project_id = p.id
      GROUP BY p.id
      ORDER BY p.id DESC
    `);
    const agencyRows = await dbPool.query(`
      SELECT ag.id, ag.hebrew_name, ag.english_name, COUNT(a.id)::int AS audition_count,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.id ORDER BY p.id DESC), NULL) AS project_ids,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name ORDER BY p.id DESC), NULL) AS project_names
      FROM agents ag
      LEFT JOIN auditions a ON a.agent_id = ag.id
      LEFT JOIN projects p ON p.id = a.project_id
      GROUP BY ag.id
      ORDER BY ag.active DESC, ag.hebrew_name ASC
    `);
    const unlinkedAuditions = await dbPool.query(`
      SELECT a.id, a.project_id, p.name AS project_name, a.role, a.first_name_en, a.last_name_en, a.first_name_he, a.last_name_he, a.agent_text
      FROM auditions a
      LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.agent_id IS NULL AND COALESCE(BTRIM(a.agent_text), '') <> ''
      ORDER BY a.created_at DESC
      LIMIT 50
    `);
    const requestRows = await dbPool.query(`
      SELECT r.*, ag.hebrew_name, ag.english_name, ag.email AS agent_email, ag.phone AS agent_phone
      FROM project_agent_requests r
      JOIN agents ag ON ag.id = r.agent_id
      ORDER BY r.created_at DESC
    `);
    const requestsByProject = new Map();
    requestRows.rows.forEach((row) => {
      if (!requestsByProject.has(row.project_id)) requestsByProject.set(row.project_id, []);
      requestsByProject.get(row.project_id).push(row);
    });
    const expectedResult = await dbPool.query(`
      SELECT pea.project_id, pea.agent_id, pea.tag_color, ag.hebrew_name, ag.english_name
      FROM project_expected_agents pea
      JOIN agents ag ON ag.id = pea.agent_id
      ORDER BY ag.hebrew_name ASC
    `);
    const expectedByProject = new Map();
    expectedResult.rows.forEach((row) => {
      if (!expectedByProject.has(row.project_id)) expectedByProject.set(row.project_id, []);
      expectedByProject.get(row.project_id).push(row);
    });
    const submissionsResult = await dbPool.query(`
      SELECT DISTINCT a.project_id, a.agent_id
      FROM auditions a
      WHERE a.agent_id IS NOT NULL
    `);
    const submittedByProject = new Map();
    submissionsResult.rows.forEach((row) => {
      if (!submittedByProject.has(row.project_id)) submittedByProject.set(row.project_id, new Set());
      submittedByProject.get(row.project_id).add(row.agent_id);
    });
    const projects = projectRows.rows.map((project) => {
      const expectedAgents = expectedByProject.get(project.id) || [];
      const submittedSet = submittedByProject.get(project.id) || new Set();
      const expectedWithStatus = expectedAgents.map((agent) => ({
        ...agent,
        submitted: submittedSet.has(agent.agent_id)
      }));
      const statusCounts = expectedWithStatus.reduce((acc, agent) => {
        const status = ['green', 'yellow', 'red'].includes(agent.tag_color) ? agent.tag_color : 'yellow';
        acc[status] += 1;
        return acc;
      }, { green: 0, yellow: 0, red: 0 });
      return {
        ...project,
        expectedAgents: expectedWithStatus,
        expectedCount: expectedAgents.length,
        missingCount: expectedWithStatus.filter((agent) => agent.tag_color !== 'green').length,
        statusCounts,
        unassignedCount: agencyRows.rows.length - expectedAgents.length,
        requests: requestsByProject.get(project.id) || []
      };
    });
    const overallSummary = projects.reduce((acc, project) => {
      acc.green += project.statusCounts.green;
      acc.yellow += project.statusCounts.yellow;
      acc.red += project.statusCounts.red;
      acc.unassigned += project.unassignedCount;
      return acc;
    }, { green: 0, yellow: 0, red: 0, unassigned: 0 });
    res.render('admin/agent-audit', {
      title: 'Agent Audit',
      projects,
      agencies: agencyRows.rows,
      unlinkedAuditions: unlinkedAuditions.rows,
      overallSummary,
      breadcrumbTrail: [
        { label: 'Home', url: '/' },
        { label: 'Admin', url: '/admin/login' },
        { label: 'Agents', url: '/admin/agents' },
        { label: 'Audit', url: '/admin/agents/audit' },
      ],
    });
  } catch (error) {
    console.error('[ADMIN_AGENT_AUDIT_LOAD_ERROR]', error);
    res.status(500).send('Could not load agent audit right now.');
  }
});

router.post('/projects/:projectId/agent-requests', requireAdmin, async (req, res) => {
  const projectId = Number(req.params.projectId);
  try {
    if (!Number.isInteger(projectId) || projectId <= 0) {
      req.flash('error', 'Invalid project id.');
      return res.redirect('/admin/agents/audit');
    }
    if (req.body.bulk_mode === '1') {
      const agentIds = Array.isArray(req.body.agent_ids) ? req.body.agent_ids : [];
      const actorNames = Array.isArray(req.body.actor_names) ? req.body.actor_names : [];
      const roleNames = Array.isArray(req.body.role_names) ? req.body.role_names : [];
      const notes = Array.isArray(req.body.notes) ? req.body.notes : [];
      for (let i = 0; i < agentIds.length; i += 1) {
        const agentId = Number(agentIds[i]);
        const actorName = (actorNames[i] || '').toString().trim();
        const roleName = (roleNames[i] || '').toString().trim();
        const note = (notes[i] || '').toString().trim();
        if (Number.isInteger(agentId) && agentId > 0 && actorName) {
          await dbPool.query(
            `INSERT INTO project_agent_requests (project_id, agent_id, actor_name, role_name, note)
             VALUES ($1, $2, $3, $4, $5)`,
            [projectId, agentId, actorName, roleName || null, note || null]
          );
        }
      }
      req.flash('success', 'Bulk requests saved.');
      return res.redirect('/admin/agents/audit');
    }
    const agentId = Number(req.body.agent_id);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      req.flash('error', 'Invalid project or agency id.');
      return res.redirect('/admin/agents/audit');
    }
    const actorName = (req.body.actor_name || '').trim();
    const roleName = (req.body.role_name || '').trim();
    const note = (req.body.note || '').trim();
    if (!actorName) {
      req.flash('error', 'Actor name is required.');
      return res.redirect('/admin/agents/audit');
    }
    await dbPool.query(
      `INSERT INTO project_agent_requests (project_id, agent_id, actor_name, role_name, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [projectId, agentId, actorName, roleName || null, note || null]
    );
    req.flash('success', 'Request added.');
    return res.redirect('/admin/agents/audit');
  } catch (error) {
    console.error('[ADMIN_PROJECT_AGENT_REQUEST_ADD_ERROR]', error);
    req.flash('error', 'Could not add request.');
    return res.redirect('/admin/agents/audit');
  }
});

router.post('/projects/:projectId/agent-requests/bulk-parse', requireAdmin, async (req, res) => {
  const projectId = Number(req.params.projectId);
  const bulkText = (req.body.bulk_text || '').toString();
  if (!Number.isInteger(projectId) || projectId <= 0) {
    req.flash('error', 'Invalid project id.');
    return res.redirect('/admin/agents/audit');
  }
  const lines = bulkText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = lines.map(parseBulkRequestLine).filter(Boolean);
  if (!parsed.length) {
    req.flash('error', 'No valid lines found. Use: Agency | Actor | Role | Note');
    return res.redirect('/admin/agents/audit');
  }
  try {
    const agentsResult = await dbPool.query(`
      SELECT
        ag.id,
        ag.hebrew_name,
        ag.english_name,
        ag.search_aliases,
        ac.contact_name,
        ac.phone,
        ac.email
      FROM agents ag
      LEFT JOIN LATERAL (
        SELECT contact_name, phone, email
        FROM agent_contacts
        WHERE agent_id = ag.id
        ORDER BY is_primary DESC, id ASC
        LIMIT 1
      ) ac ON TRUE
      WHERE ag.active = TRUE
      ORDER BY ag.hebrew_name ASC
    `);
    const enriched = parsed.map((row) => ({
      ...row,
      candidates: agentsResult.rows
        .map((agent) => {
          const agentScore = scoreAgentMatch(row.agencyName, agent);
          const contactScore = scoreAgentContactMatch(row.agencyName, agent);
          return {
            ...agent,
            score: Math.max(agentScore, contactScore),
            matchedVia: contactScore > agentScore ? 'contact' : 'agency'
          };
        })
        .filter((agent) => agent.score > 0)
        .sort((a, b) => b.score - a.score || a.hebrew_name.localeCompare(b.hebrew_name))
        .slice(0, 3)
    })).map((row) => ({
      ...row,
      agent: row.candidates[0] && row.candidates[0].score >= 90 ? row.candidates[0] : null
    }));
    const project = await getProjectById(projectId);
    return res.render('admin/agent-request-preview', {
      title: 'Request Preview',
      projectId,
      rows: enriched,
      project,
      breadcrumbTrail: [
        { label: 'Home', url: '/' },
        { label: 'Admin', url: '/admin/login' },
        { label: 'Agents', url: '/admin/agents' },
        { label: 'Audit', url: '/admin/agents/audit' },
      ],
    });
  } catch (error) {
    console.error('[ADMIN_AGENT_REQUEST_BULK_PARSE_ERROR]', error);
    req.flash('error', 'Could not parse bulk requests.');
    return res.redirect('/admin/agents/audit');
  }
});

router.post('/project-agent-requests/:requestId/delete', requireAdmin, async (req, res) => {
  const requestId = Number(req.params.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    req.flash('error', 'Invalid request id.');
    return res.redirect('/admin/agents/audit');
  }
  try {
    await dbPool.query('DELETE FROM project_agent_requests WHERE id = $1', [requestId]);
    req.flash('success', 'Request removed.');
    return res.redirect('/admin/agents/audit');
  } catch (error) {
    console.error('[ADMIN_PROJECT_AGENT_REQUEST_DELETE_ERROR]', error);
    req.flash('error', 'Could not remove request.');
    return res.redirect('/admin/agents/audit');
  }
});

router.post('/projects/:projectId/send-request-emails', requireAdmin, async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    req.flash('error', 'Invalid project id.');
    return res.redirect('/admin/agents/audit');
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    req.flash('error', 'SMTP is not configured.');
    return res.redirect('/admin/agents/audit');
  }
  try {
    const project = await getProjectById(projectId);
    if (!project) {
      req.flash('error', 'Project not found.');
      return res.redirect('/admin/agents/audit');
    }
    const { rows } = await dbPool.query(`
      SELECT r.*, ag.english_name, ag.hebrew_name, ag.email AS agent_email
      FROM project_agent_requests r
      JOIN agents ag ON ag.id = r.agent_id
      WHERE r.project_id = $1
      ORDER BY ag.hebrew_name ASC, r.created_at ASC
    `, [projectId]);
    if (!rows.length) {
      req.flash('info', 'No requests to send.');
      return res.redirect('/admin/agents/audit');
    }
    const grouped = new Map();
    rows.forEach((row) => {
      const key = row.agent_id;
      if (!grouped.has(key)) grouped.set(key, { agent: row, items: [] });
      grouped.get(key).items.push(row);
    });
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    for (const { agent, items } of grouped.values()) {
      const recipient = agent.agent_email;
      if (!recipient) continue;
      const lines = items.map((item) => `- ${item.actor_name}${item.role_name ? ` (${item.role_name})` : ''}${item.note ? `: ${item.note}` : ''}`);
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: recipient,
        subject: `${project.name} - self tape request`,
        text: [
          `Hello ${agent.english_name || agent.hebrew_name || ''},`,
          '',
          `For the project "${project.name}", we kindly ask to receive self-tapes for:`,
          ...lines,
          '',
          'Thank you.'
        ].join('\n'),
      });
      await dbPool.query(
        `UPDATE project_agent_requests
         SET email_sent_at = NOW(), email_sent_to = $2, updated_at = NOW()
         WHERE project_id = $1 AND agent_id = $3`,
        [projectId, recipient, agent.agent_id]
      );
    }
    req.flash('success', 'Request emails sent.');
    return res.redirect('/admin/agents/audit');
  } catch (error) {
    console.error('[ADMIN_PROJECT_AGENT_REQUEST_EMAIL_ERROR]', error);
    req.flash('error', `Could not send request emails: ${error.message}`);
    return res.redirect('/admin/agents/audit');
  }
});

module.exports = router;
