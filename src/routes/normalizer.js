import { randomUUID } from 'crypto';

/**
 * Normalize any incoming webhook payload into the standard internal event schema.
 * Returns: { id, source, title, body, severity, timestamp, metadata }
 */
export function normalizePayload(source, payload) {
  const id = randomUUID();
  const timestamp = Date.now();

  switch (source) {
    case 'github':
      return normalizeGitHub(id, timestamp, payload);
    case 'docker':
      return normalizeDocker(id, timestamp, payload);
    case 'kubernetes':
    case 'k8s':
      return normalizeKubernetes(id, timestamp, payload);
    case 'uptime':
      return normalizeUptime(id, timestamp, payload);
    default:
      return normalizeGeneric(id, source, timestamp, payload);
  }
}

function normalizeGitHub(id, timestamp, p) {
  const action = p.action || '';
  const workflow = p.workflow_run || p.workflow_job || {};
  const repo = p.repository?.full_name || 'unknown';
  const conclusion = workflow.conclusion || action;
  const title = `GitHub: ${repo} — ${workflow.name || action}`;
  const body = `Status: ${conclusion} | Branch: ${workflow.head_branch || 'unknown'}`;
  const severity = conclusion === 'failure' ? 'warning' : 'info';

  return {
    id, source: 'github', title, body, severity,
    timestamp,
    metadata: { repo, conclusion, action, branch: workflow.head_branch }
  };
}

function normalizeDocker(id, timestamp, p) {
  const container = p.Actor?.Attributes?.name || p.id || 'unknown';
  const status = p.status || p.Action || 'unknown';
  const restartCount = parseInt(p.Actor?.Attributes?.restartCount || '0', 10);
  const title = `Docker: ${container} — ${status}`;
  const body = `Container: ${container} | Status: ${status} | Restarts: ${restartCount}`;
  const severity = restartCount > 5 || status === 'die' ? 'warning' : 'info';

  return {
    id, source: 'docker', title, body, severity,
    timestamp,
    metadata: { container, status, restartCount }
  };
}

function normalizeKubernetes(id, timestamp, p) {
  const kind = p.involvedObject?.kind || p.kind || 'Pod';
  const name = p.involvedObject?.name || p.metadata?.name || 'unknown';
  const namespace = p.involvedObject?.namespace || p.metadata?.namespace || 'default';
  const reason = p.reason || p.status || 'unknown';
  const message = p.message || p.body || '';
  const restartCount = parseInt(p.restartCount || '0', 10);
  const title = `K8s: ${kind}/${name} (${namespace}) — ${reason}`;
  const body = message || `Reason: ${reason} | Restarts: ${restartCount}`;
  const criticalReasons = ['CrashLoopBackOff', 'OOMKilled', 'Error', 'BackOff'];
  const severity = criticalReasons.includes(reason) ? 'critical' : 'info';

  return {
    id, source: 'kubernetes', title, body, severity,
    timestamp,
    metadata: { kind, name, namespace, reason, restartCount, message }
  };
}

function normalizeUptime(id, timestamp, p) {
  const url = p.url || 'unknown';
  const status = parseInt(p.status || p.statusCode || '0', 10);
  const responseTime = p.responseTime || null;
  const down = status === 0 || status >= 400;
  const title = p.recovered
    ? `✅ Uptime recovered: ${url} — ${status}`
    : `Uptime: ${url} — ${status === 0 ? 'timeout/error' : status}`;
  const body = `URL: ${url} | HTTP ${status}${responseTime ? ` | ${responseTime}ms` : ''}`;
  const severity = down ? 'critical' : 'info';

  return {
    id, source: 'uptime', title, body, severity,
    timestamp,
    metadata: { url, status, responseTime, state: down ? 'down' : 'up' }
  };
}

function normalizeGeneric(id, source, timestamp, p) {
  const title = p.title || p.summary || p.name || `Event from ${source}`;
  const body = p.body || p.message || p.description || JSON.stringify(p).slice(0, 500);
  const severity = p.severity || p.level || 'info';

  return {
    id, source, title, body, severity,
    timestamp,
    metadata: p
  };
}
