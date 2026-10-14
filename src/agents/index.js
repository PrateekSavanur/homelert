import db from '../db/index.js';
import { normalizePayload } from '../routes/normalizer.js';
import { evaluateRules } from '../rules/engine.js';

const agentStatuses = {};

function setStatus(name, status, detail = '') {
  agentStatuses[name] = { name, status, detail, lastRun: Date.now() };
}

function ingestAgentEvent(source, payload) {
  const event = normalizePayload(source, payload);
  db.prepare(`
    INSERT INTO events (id, source, title, body, severity, timestamp, raw_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.source, event.title, event.body,
    event.severity, event.timestamp, JSON.stringify(payload)
  );
  evaluateRules(event);
  return event;
}

export function getAgentStatuses() {
  return Object.values(agentStatuses);
}

export function startAllAgents() {
  const interval = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10) * 1000;

  startProxmoxAgent(interval);
  startDockerAgent(interval);
  startKubernetesAgent(interval);
  startUptimeAgent(interval);
}

// ─── Proxmox Agent ─────────────────────────────────────────────────────────────
async function runProxmoxAgent() {
  const host = process.env.PROXMOX_HOST;
  const token = process.env.PROXMOX_TOKEN;

  if (!host || !token) {
    setStatus('proxmox', 'disabled', 'PROXMOX_HOST or PROXMOX_TOKEN not set');
    return;
  }

  try {
    const res = await fetch(`${host}/api2/json/nodes`, {
      headers: { Authorization: `PVEAPIToken=${token}` },
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data: nodes } = await res.json();

    for (const node of nodes) {
      const cpu = Math.round((node.cpu || 0) * 100);
      const ram = Math.round(((node.mem || 0) / (node.maxmem || 1)) * 100);
      const disk = Math.round(((node.disk || 0) / (node.maxdisk || 1)) * 100);

      ingestAgentEvent('proxmox', {
        node: node.node,
        cpu,
        ram,
        disk,
        title: `Proxmox node ${node.node}`,
        body: `CPU: ${cpu}% | RAM: ${ram}% | Disk: ${disk}%`,
        severity: cpu > 90 || ram > 90 || disk > 90 ? 'critical' : cpu > 80 || ram > 80 || disk > 80 ? 'warning' : 'info'
      });
    }

    setStatus('proxmox', 'ok', `Polled ${nodes.length} node(s)`);
  } catch (err) {
    setStatus('proxmox', 'error', err.message);
  }
}

function startProxmoxAgent(interval) {
  setStatus('proxmox', 'starting');
  runProxmoxAgent();
  setInterval(runProxmoxAgent, interval);
}

// ─── Docker Agent ──────────────────────────────────────────────────────────────
async function runDockerAgent() {
  const socketPath = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';

  try {
    // Fetch container list via Docker socket
    const res = await fetch('http://localhost/containers/json?all=true', {
      socketPath,
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) throw new Error(`Docker API HTTP ${res.status}`);
    const containers = await res.json();

    for (const c of containers) {
      const name = (c.Names?.[0] || c.Id).replace(/^\//, '');
      const status = c.Status || 'unknown';
      const state = c.State || 'unknown';
      const restartCount = c.RestartCount || 0;

      if (state !== 'running' || restartCount > 0) {
        ingestAgentEvent('docker', {
          container: name,
          status,
          state,
          restartCount,
          title: `Docker: ${name} — ${state}`,
          body: `Container: ${name} | Status: ${status} | Restarts: ${restartCount}`
        });
      }
    }

    setStatus('docker', 'ok', `Polled ${containers.length} container(s)`);
  } catch (err) {
    setStatus('docker', 'error', err.message);
  }
}

function startDockerAgent(interval) {
  setStatus('docker', 'starting');
  runDockerAgent();
  setInterval(runDockerAgent, interval);
}

// ─── Kubernetes Agent ──────────────────────────────────────────────────────────
async function runKubernetesAgent() {
  const kubeconfigPath = process.env.K8S_KUBECONFIG_PATH;
  const saTokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
  const { readFileSync, existsSync } = await import('fs');
  const inCluster = !kubeconfigPath && process.env.KUBERNETES_SERVICE_HOST && existsSync(saTokenPath);

  if (!kubeconfigPath && !inCluster) {
    setStatus('kubernetes', 'disabled', 'K8S_KUBECONFIG_PATH not set');
    return;
  }

  try {
    let cluster, user;
    if (inCluster) {
      // Running as a pod: use the mounted ServiceAccount token (re-read each run, it rotates).
      // The cluster CA must be trusted via NODE_EXTRA_CA_CERTS.
      cluster = { server: `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT || 443}` };
      user = { token: readFileSync(saTokenPath, 'utf8').trim() };
    } else {
      const yaml = await import('js-yaml');
      const kubeconfig = yaml.load(readFileSync(kubeconfigPath, 'utf8'));
      cluster = kubeconfig.clusters?.[0]?.cluster;
      user = kubeconfig.users?.[0]?.user;
    }

    if (!cluster?.server) throw new Error('Invalid kubeconfig: no server');

    const headers = { 'Content-Type': 'application/json' };

    // Build auth headers
    if (user?.token) {
      headers['Authorization'] = `Bearer ${user.token}`;
    }

    // Fetch pod events for all namespaces
    const eventsRes = await fetch(`${cluster.server}/api/v1/events?fieldSelector=type=Warning`, {
      headers,
      signal: AbortSignal.timeout(10000)
    });

    if (!eventsRes.ok) throw new Error(`K8s API HTTP ${eventsRes.status}`);
    const eventsData = await eventsRes.json();
    const k8sEvents = eventsData.items || [];

    // Only process recent events (last 5 minutes)
    const cutoff = Date.now() - 5 * 60 * 1000;

    for (const ev of k8sEvents) {
      const lastTime = ev.lastTimestamp ? new Date(ev.lastTimestamp).getTime() : 0;
      if (lastTime < cutoff) continue;

      const reason = ev.reason || 'Unknown';
      const message = ev.message || '';
      const name = ev.involvedObject?.name || 'unknown';
      const namespace = ev.involvedObject?.namespace || 'default';
      const restartCount = ev.count || 0;

      ingestAgentEvent('kubernetes', {
        reason,
        message,
        name,
        namespace,
        restartCount,
        involvedObject: ev.involvedObject
      });
    }

    setStatus('kubernetes', 'ok', `Processed ${k8sEvents.length} warning event(s)`);
  } catch (err) {
    setStatus('kubernetes', 'error', err.message);
  }
}

function startKubernetesAgent(interval) {
  setStatus('kubernetes', 'starting');
  runKubernetesAgent();
  setInterval(runKubernetesAgent, interval);
}

// ─── Uptime Agent ──────────────────────────────────────────────────────────────
function getUptimeUrls() {
  const raw = process.env.UPTIME_URLS || '';
  if (!raw.trim()) return [];
  return raw.split(',').map(u => u.trim()).filter(Boolean);
}

// Last known state per URL (true = down), so a recovery can be reported once when a down URL
// answers again. Seeded from the last stored uptime event so a restart mid-outage still
// reports the recovery.
const uptimeDown = new Map();

function wasDown(url) {
  if (!uptimeDown.has(url)) {
    const last = db.prepare(`
      SELECT raw_payload FROM events
      WHERE source = 'uptime' AND json_extract(raw_payload, '$.url') = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(url);
    const status = last ? JSON.parse(last.raw_payload).status : 200;
    uptimeDown.set(url, status === 0 || status >= 400);
  }
  return uptimeDown.get(url);
}

async function runUptimeAgent() {
  const urls = getUptimeUrls();

  if (urls.length === 0) {
    setStatus('uptime', 'disabled', 'UPTIME_URLS not set');
    return;
  }

  let checked = 0;
  let errors = 0;

  await Promise.allSettled(urls.map(async (url) => {
    const start = Date.now();
    let status = 0;
    let responseTime = null;
    let error = null;

    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
        redirect: 'follow'
      });
      status = res.status;
      responseTime = Date.now() - start;
    } catch (err) {
      status = 0;
      error = err.message;
      errors++;
    }

    checked++;

    // Always ingest if non-200 or error; ingest a success only when it ends an outage
    const down = status === 0 || status >= 400;
    if (down) {
      ingestAgentEvent('uptime', {
        url,
        status,
        responseTime,
        error
      });
    } else if (wasDown(url)) {
      ingestAgentEvent('uptime', {
        url,
        status,
        responseTime,
        recovered: true
      });
    }
    uptimeDown.set(url, down);
  }));

  setStatus('uptime', errors > 0 ? 'warning' : 'ok', `Checked ${checked} URL(s), ${errors} error(s)`);
}

function startUptimeAgent(interval) {
  setStatus('uptime', 'starting');
  runUptimeAgent();
  setInterval(runUptimeAgent, interval);
}
