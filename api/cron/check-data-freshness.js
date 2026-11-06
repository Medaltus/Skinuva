/**
 * api/cron/check-data-freshness.js
 * ADDED 2026-11-06 per Jaclyn. The Google Ads sync stopped on 2026-10-02 and
 * nobody was alerted: its schedule had dropped out of vercel.json, so the
 * function never ran, and sendCronFailureAlert only fires from INSIDE a run.
 * A cron that isn't scheduled, or a deploy that drops one, can't alert by
 * itself. This watchdog doesn't depend on the other crons running at all: it
 * reads the sheets they write and emails an alert (same sendCronFailureAlert
 * as every cron) when any tab hasn't been updated within its allowed window.
 *
 * Runs daily at 0 12 * * * UTC, after every Skinuva sync (07:00–07:30 UTC).
 * Also alerts if the check itself fails (sheet unreadable, etc.).
 *
 * Add a tab to CHECKS when a new cron starts writing one.
 */

const { readRows }             = require('../config/_sheets_client');
const { sendCronFailureAlert } = require('../_alerts');

const SHOPIFY_SHEET = process.env.SHOPIFY_ORDERS_SHEET;

// column: which column holds the freshness date. 'last_updated' columns are
// stamped by the sync on each write (EST time with a literal Z, so only the
// YYYY-MM-DD part is used). 'date' = newest data date in the tab.
// maxAgeDays: alert when the newest value is older than this many days.
const CHECKS = [
  { cron: 'sync-shopify-orders',  sheet: SHOPIFY_SHEET, tab: 'orders',   column: 'last_updated', maxAgeDays: 2 },
  { cron: 'sync-shopify-revenue', sheet: SHOPIFY_SHEET, tab: 'Revenue',  column: 'last updated', maxAgeDays: 2 },
  // Google Ads writes one row per campaign per day with impressions, so the
  // newest DATE should be yesterday (2 days of slack for API lag).
  { cron: 'sync-google-ads',      sheet: SHOPIFY_SHEET, tab: 'ads',      column: 'date',         maxAgeDays: 3 },
  { cron: 'sync-google-ads',      sheet: SHOPIFY_SHEET, tab: 'shopping', column: 'last_updated', maxAgeDays: 3 },
  // Returns and subscriptions are left out on purpose: returns only gets
  // rows when a refund happens (weeks can pass with none), so "no new row"
  // isn't a failure signal there.
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = todayEst();
  const results = [];
  const problems = [];

  for (const c of CHECKS) {
    if (!c.sheet) {
      problems.push(`${c.tab}: sheet env var not set`);
      results.push({ ...c, sheet: undefined, ok: false, error: 'sheet env var not set' });
      continue;
    }
    try {
      const rows = await readRows(c.sheet, c.tab);
      const newest = newestDate(rows, c.column);
      const ageDays = newest ? daysBetween(newest, today) : null;
      const ok = newest != null && ageDays <= c.maxAgeDays;
      results.push({ cron: c.cron, tab: c.tab, newest, ageDays, maxAgeDays: c.maxAgeDays, ok });
      if (!ok) {
        problems.push(newest
          ? `${c.tab} tab (${c.cron}): newest ${c.column} is ${newest}, ${ageDays} days old (limit ${c.maxAgeDays})`
          : `${c.tab} tab (${c.cron}): no readable ${c.column} values`);
      }
    } catch (err) {
      results.push({ cron: c.cron, tab: c.tab, ok: false, error: err.message });
      problems.push(`${c.tab} tab (${c.cron}): could not be read — ${err.message}`);
    }
  }

  if (problems.length) {
    console.error('[check-data-freshness] stale:', problems);
    await sendCronFailureAlert(
      'check-data-freshness',
      `${problems.length} data feed(s) look stale — a cron may not be running:\n` + problems.join('\n'),
      { 'Checked on (EST)': today, 'What to check': 'Vercel → Cron Jobs (is the job listed and succeeding?) and vercel.json crons list' }
    );
  } else {
    console.log('[check-data-freshness] all feeds fresh', results);
  }

  return res.status(200).json({ today, ok: problems.length === 0, problems, results });
};

// Newest YYYY-MM-DD in a column (header matched case-insensitively, spaces
// and underscores ignored). Accepts ISO dates/timestamps and M/D/YYYY.
function newestDate(rows, column) {
  if (!rows || !rows.length) return null;
  const norm = s => String(s).toLowerCase().replace(/[\s_]/g, '');
  const key = Object.keys(rows[0]).find(k => norm(k) === norm(column));
  if (!key) return null;
  let best = null;
  rows.forEach(r => {
    const d = toIsoDate(r[key]);
    if (d && (!best || d > best)) best = d;
  });
  return best;
}

function toIsoDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}

function todayEst() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
