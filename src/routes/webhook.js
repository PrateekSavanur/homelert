import db from '../db/index.js';
import { normalizePayload } from './normalizer.js';
import { evaluateRules } from '../rules/engine.js';

export default async function webhookRoutes(fastify) {
  fastify.post('/:source', {
    schema: {
      params: {
        type: 'object',
        properties: { source: { type: 'string' } },
        required: ['source']
      }
    }
  }, async (request, reply) => {
    const { source } = request.params;
    const payload = request.body || {};

    // Sanitize source name — only allow alphanumeric + dash/underscore
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(source)) {
      return reply.code(400).send({ error: 'Invalid source name' });
    }

    const event = normalizePayload(source, payload);

    // Persist event to DB
    db.prepare(`
      INSERT INTO events (id, source, title, body, severity, timestamp, raw_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.source,
      event.title,
      event.body,
      event.severity,
      event.timestamp,
      JSON.stringify(payload)
    );

    fastify.log.info({ eventId: event.id, source: event.source }, 'Event ingested');

    // Run rules engine async (don't block webhook response)
    setImmediate(() => evaluateRules(event));

    return reply.code(202).send({ accepted: true, eventId: event.id });
  });
}
