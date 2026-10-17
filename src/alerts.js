"use strict";
// Sends alerts to a Slack- or Discord-compatible incoming webhook.

async function sendWebhook(url, text, fetchImpl = globalThis.fetch) {
  if (!url) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Wires store events to webhook alerts. */
function attachAlerts(store, getConfig, log = console, fetchImpl) {
  // Questions already alerted, so one that reopens (or a second transition into it) doesn't alert again.
  const alerted = new Set();
  store.on("transition", ({ agent, to }) => {
    const cfg = getConfig();
    if (to !== "waiting" || !cfg.notifyOnWaiting || !cfg.webhookUrl) return;
    const key = agent.question ? `${agent.session}:${agent.question.id}` : null;
    if (key && alerted.has(key)) return;
    if (key) { alerted.add(key); if (alerted.size > 1000) alerted.delete(alerted.values().next().value); }
    const where = agent.host ? ` on ${agent.host}` : "";
    sendWebhook(cfg.webhookUrl, `🟠 ${agent.name}${where} needs you: ${agent.message || "waiting for input"}`, fetchImpl)
      .then((ok) => { if (!ok) log.warn("Webhook alert failed"); });
  });
  store.on("budget", ({ spent, budget }) => {
    const cfg = getConfig();
    if (!cfg.webhookUrl) return;
    sendWebhook(cfg.webhookUrl, `💸 Claude spend today is $${spent.toFixed(2)}, over your $${budget.toFixed(2)} daily budget.`, fetchImpl)
      .then((ok) => { if (!ok) log.warn("Webhook alert failed"); });
  });
}

module.exports = { sendWebhook, attachAlerts };
