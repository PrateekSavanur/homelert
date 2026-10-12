import db from '../db/index.js';

export default async function apiRoutes(fastify) {
  // Get alert history (latest 50, filterable)
  fastify.get('/alerts', async (request) => {
    const { severity, source, limit = 50 } = request.query;
    const safeLimit = Math.min(parseInt(limit, 10) || 50, 200);

    let query = 'SELECT * FROM alerts WHERE 1=1';
    const params = [];

    if (severity) {
      query += ' AND severity = ?';
      params.push(severity);
    }
    if (source) {
      query += ' AND source = ?';
      params.push(source);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(safeLimit);

    return db.prepare(query).all(...params);
  });

  // Get events history
  fastify.get('/events', async (request) => {
    const { severity, source, limit = 50 } = request.query;
    const safeLimit = Math.min(parseInt(limit, 10) || 50, 200);

    let query = 'SELECT id, source, title, body, severity, timestamp, created_at FROM events WHERE 1=1';
    const params = [];

    if (severity) {
      query += ' AND severity = ?';
      params.push(severity);
    }
    if (source) {
      query += ' AND source = ?';
      params.push(source);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(safeLimit);

    return db.prepare(query).all(...params);
  });

  // Get active rules
  fastify.get('/rules', async () => {
    const { getRules } = await import('../rules/engine.js');
    return getRules();
  });

  // Get agent statuses
  fastify.get('/agents', async () => {
    const { getAgentStatuses } = await import('../agents/index.js');
    return getAgentStatuses();
  });

  // Get active silences
  fastify.get('/silences', async () => {
    return db.prepare('SELECT * FROM silences WHERE active = 1 ORDER BY created_at DESC').all();
  });

  // Create a silence
  fastify.post('/silences', async (request, reply) => {
    const { label, from_time, to_time } = request.body || {};
    if (!from_time || !to_time) {
      return reply.code(400).send({ error: 'from_time and to_time are required' });
    }

    // Validate time format HH:MM
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(from_time) || !timeRegex.test(to_time)) {
      return reply.code(400).send({ error: 'Times must be in HH:MM format' });
    }

    const result = db.prepare(`
      INSERT INTO silences (label, from_time, to_time, active)
      VALUES (?, ?, ?, 1)
    `).run(label || null, from_time, to_time);

    return reply.code(201).send({ id: result.lastInsertRowid });
  });

  // Delete a silence
  fastify.delete('/silences/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid id' });

    db.prepare('UPDATE silences SET active = 0 WHERE id = ?').run(id);
    return { ok: true };
  });

  // Stats summary
  fastify.get('/stats', async () => {
    const totalAlerts = db.prepare('SELECT COUNT(*) as count FROM alerts').get();
    const totalEvents = db.prepare('SELECT COUNT(*) as count FROM events').get();
    const bySeverity = db.prepare(`
      SELECT severity, COUNT(*) as count FROM alerts GROUP BY severity
    `).all();
    const bySource = db.prepare(`
      SELECT source, COUNT(*) as count FROM alerts GROUP BY source ORDER BY count DESC LIMIT 10
    `).all();

    return {
      totalAlerts: totalAlerts.count,
      totalEvents: totalEvents.count,
      bySeverity,
      bySource
    };
  });
}
