import db from '../db/index.js';

const SEVERITY_EMOJI = {
  critical: '❌',
  warning: '⚠️',
  info: 'ℹ️'
};

function formatMessage(alert) {
  const emoji = SEVERITY_EMOJI[alert.severity] || 'ℹ️';
  const ts = new Date(alert.timestamp).toISOString().replace('T', ' ').slice(0, 19);

  return [
    `${emoji} *[${(alert.severity || 'info').toUpperCase()}] ${escapeMarkdown(alert.title)}*`,
    ``,
    `📡 *Source:* \`${escapeMarkdown(alert.source)}\``,
    `🕐 *Time:* \`${ts} UTC\``,
    alert.rule_name ? `📋 *Rule:* \`${escapeMarkdown(alert.rule_name)}\`` : null,
    ``,
    alert.body ? `${escapeMarkdown(alert.body)}` : null,
  ].filter(Boolean).join('\n');
}

function escapeMarkdown(text) {
  if (!text) return '';
  // Escape MarkdownV2 special chars
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

export async function sendTelegramAlert(alert) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set, skipping notification');
    return;
  }

  const text = formatMessage(alert);

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(15000)
    });

    const data = await res.json();

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }

    // Mark alert as notified
    if (alert.id) {
      db.prepare('UPDATE alerts SET notified = 1 WHERE id = ?').run(alert.id);
    }

    console.log(`[telegram] Sent alert: ${alert.title}`);
  } catch (err) {
    console.error(`[telegram] Failed to send notification: ${err.message}`);
  }
}
