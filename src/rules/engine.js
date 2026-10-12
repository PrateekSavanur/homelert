import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import db from '../db/index.js';
import { sendTelegramAlert } from '../notifiers/telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let rules = [];
let silences = [];

export function getRules() {
  return rules;
}

export async function loadRules() {
  const rulesPath = process.env.RULES_PATH || path.join(__dirname, '..', '..', 'rules.yaml');

  if (!fs.existsSync(rulesPath)) {
    console.warn(`[rules] rules.yaml not found at ${rulesPath}, using empty ruleset`);
    return;
  }

  try {
    const content = fs.readFileSync(rulesPath, 'utf8');
    const parsed = yaml.load(content);

    rules = (parsed.rules || []).map(r => ({
      ...r,
      windowMs: parseWindowToMs(r.window)
    }));

    silences = parsed.silences || [];

    // Also load DB silences
    const dbSilences = db.prepare('SELECT * FROM silences WHERE active = 1').all();
    for (const s of dbSilences) {
      silences.push({ from: s.from_time, to: s.to_time, label: s.label });
    }

    console.log(`[rules] Loaded ${rules.length} rule(s), ${silences.length} silence(s)`);
  } catch (err) {
    console.error(`[rules] Failed to load rules.yaml: ${err.message}`);
  }
}

function parseWindowToMs(window) {
  if (!window) return 0;
  const match = String(window).match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const [, num, unit] = match;
  const multipliers = { s: 1000, m: 60000, h: 3600000 };
  return parseInt(num, 10) * multipliers[unit];
}

function isInSilenceWindow() {
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // Also check DB silences
  const dbSilences = db.prepare('SELECT * FROM silences WHERE active = 1').all();
  const allSilences = [...silences, ...dbSilences.map(s => ({ from: s.from_time, to: s.to_time }))];

  for (const silence of allSilences) {
    const from = silence.from;
    const to = silence.to;

    if (!from || !to) continue;

    // Handle overnight windows (e.g. 22:00 to 06:00)
    if (from <= to) {
      if (currentTime >= from && currentTime <= to) return true;
    } else {
      if (currentTime >= from || currentTime <= to) return true;
    }
  }

  return false;
}

/**
 * Evaluate a rule condition against an event's data.
 * Supports: ==, !=, >, <, >=, <=, AND, OR
 */
function evaluateCondition(condition, eventData) {
  try {
    // Build a context object merging event fields and metadata
    const ctx = {
      source: eventData.source,
      severity: eventData.severity,
      title: eventData.title,
      ...eventData.metadata
    };

    // Tokenize condition — replace string literals, then evaluate
    // We do this safely without eval by parsing the condition manually
    return parseAndEval(condition, ctx);
  } catch {
    return false;
  }
}

function parseAndEval(condition, ctx) {
  // Split on AND/OR (case-insensitive) with token boundary
  const orParts = condition.split(/\bOR\b/i);
  if (orParts.length > 1) {
    return orParts.some(p => parseAndEval(p.trim(), ctx));
  }

  const andParts = condition.split(/\bAND\b/i);
  if (andParts.length > 1) {
    return andParts.every(p => parseAndEval(p.trim(), ctx));
  }

  // Single comparison: lhs op rhs
  const match = condition.trim().match(/^(\w+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) return false;

  const [, lhs, op, rhsRaw] = match;
  const lhsVal = ctx[lhs];

  // Parse rhs — strip quotes for strings
  let rhs;
  const strMatch = rhsRaw.trim().match(/^['"](.*)['"]$/);
  if (strMatch) {
    rhs = strMatch[1];
  } else if (!isNaN(Number(rhsRaw.trim()))) {
    rhs = Number(rhsRaw.trim());
  } else {
    rhs = rhsRaw.trim();
  }

  switch (op) {
    case '==': return lhsVal == rhs;
    case '!=': return lhsVal != rhs;
    case '>':  return Number(lhsVal) > Number(rhs);
    case '<':  return Number(lhsVal) < Number(rhs);
    case '>=': return Number(lhsVal) >= Number(rhs);
    case '<=': return Number(lhsVal) <= Number(rhs);
    default:   return false;
  }
}

export function evaluateRules(event) {
  if (rules.length === 0) return;
  if (isInSilenceWindow()) {
    console.log(`[rules] In silence window, skipping notifications`);
    return;
  }

  for (const rule of rules) {
    console.log(`[rules] Checking "${rule.name}" against event:`, JSON.stringify({ source: event.source, severity: event.severity }));
    console.log(`[rules] Condition result:`, evaluateCondition(rule.condition, event));
    if (!evaluateCondition(rule.condition, event)) continue;

    // Deduplication: don't fire same rule for same source within window
    if (rule.windowMs > 0) {
      const windowStart = Date.now() - rule.windowMs;
      const existing = db.prepare(`
        SELECT id FROM alerts
        WHERE rule_name = ? AND source = ? AND timestamp > ?
        LIMIT 1
      `).get(rule.name, event.source, windowStart);

      if (existing) {
        console.log(`[rules] Rule "${rule.name}" deduplicated for source "${event.source}"`);
        continue;
      }
    }

    // Fire alert
    const alert = {
      event_id: event.id,
      rule_name: rule.name,
      severity: rule.severity || event.severity,
      source: event.source,
      title: event.title,
      body: event.body,
      timestamp: event.timestamp
    };

    const result = db.prepare(`
      INSERT INTO alerts (event_id, rule_name, severity, source, title, body, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      alert.event_id, alert.rule_name, alert.severity,
      alert.source, alert.title, alert.body, alert.timestamp
    );

    console.log(`[rules] Alert fired: ${rule.name} (${alert.severity}) for ${event.source}`);

    // Send notification
    sendTelegramAlert({ ...alert, id: result.lastInsertRowid });
  }
}
