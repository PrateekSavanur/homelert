import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db/index.js';
import webhookRoutes from './routes/webhook.js';
import apiRoutes from './routes/api.js';
import { loadRules } from './rules/engine.js';
import { startAllAgents } from './agents/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
});

// Serve static dashboard
fastify.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/'
});

// Register routes
fastify.register(webhookRoutes, { prefix: '/webhook' });
fastify.register(apiRoutes, { prefix: '/api' });

// Health check
fastify.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

const start = async () => {
  try {
    // Load rules from yaml
    await loadRules();

    // Start polling agents
    startAllAgents();

    const port = parseInt(process.env.PORT || '3000', 10);
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Homelert running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
