/**
 * api/cron/sync-shopify-revenue.js
 * Runs daily — reads Shopify orders sheet, aggregates revenue for the
 * current month and last month only, and upserts those rows into THREE
 * separate revenue tabs, split by order type (Skinuva-specific, added
 * 2026-08-10 per Jaclyn):
 *
 *   - "revenue"               → Customer orders only  (sku starts with "C-")
 *   - "revenue_physician"     → Physician orders only  (sku starts with "P-")
 *   - "revenue_international" → International orders only (sku starts "I-")
 *
 * Sample orders (sku starts with "S-") are deliberately excluded from all
 * three — not tracked by this cron at all, per Jaclyn.
 *
 * IMPORTANT: "revenue" changed meaning here. Before this change it held
 * ALL order types combined; it now holds Customer-only, to match the
 * dashboard's Sales > Website > Customer tab and the PDF export's
 * "Website (Customer)" checkbox, both of which read this exact tab. If
 * anything else was relying on "revenue" meaning "all order types
 * combined," it will now under-report — the three tabs would need to be
 * summed together to reconstruct that old combined total.
 *
 * A line item with no recognized prefix (shouldn't happen in practice,
 * but defensively) is skipped from all three tabs rather than silently
 * bucketed into one.
 *
 * Only current + last month are updated on each run, per tab. All
 * historical rows are preserved and written back untouched.
 *
 * Source sheet:   SHOPIFY_ORDERS_SHEET  (tab: orders)
 * Revenue sheets: SHOPIFY_ORDERS_SHEET  (tabs: revenue, revenue_physician,
 *                 revenue_international)
 * Returns sheet:  SHOPIFY_ORDERS_SHEET  (tab: returns) — same spreadsheet as
 *   orders/revenue. Adapted from évolis's equivalent cron (2026-08-10) —
 *   Skinuva's SHOPIFY_ORDERS_SHEET points at its own dedicated Google Sheet
 *   (a separate file from évolis's, since Skinuva has its own Shopify
 *   store/credentials entirely), but the tab-NAME structure within that
 *   file is expected to match évolis's: "orders", "revenue", "returns".
 *   These crons never reference gids at all — ensureTab/readRows/
 *   replaceRows all operate on tab name, not gid, so this works regardless
 *   of what the underlying gid numbers happen to be in Skinuva's file.
 *   If Skinuva's actual tab names differ, update ORDERS_TAB/RETURNS_TAB
 *   below.
 *
 * Revenue headers (same on all three tabs): MONTH | YEAR | REVENUE |
 *   UNITS ORDERED | LAST UPDATED
 *
 * RETURNS NETTING — added 2026-08-05 per Jaclyn, extended 2026-08-10 to be
 * order-type-aware. REVENUE and UNITS ORDERED are netted against the
 * returns tab, matched by refund_date falling in the target month AND by
 * the return row's own sku prefix matching that order type — a Physician
 * return should only ever net against Physician revenue, not Customer's.
 * Same "net this month's real activity" convention as the Amazon and
 * Walmart revenue crons' own netting. Confirmed field names: refund_date,
 * sku, quantity, refund_amount — a real dollar field, so this is a direct
 * subtraction, not an estimate the way Amazon's returns needed to be.
 *
 * If the returns tab doesn't exist or fails to read, this fails soft
 * (nets $0/0 units) rather than blocking the revenue sync.
 *
 * Schedule: daily at 7AM UTC ("0 7 * * *") — same run as sync-shopify-orders
 * so revenue is always updated after orders are written.
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');
const { sendCronFailureAlert }             = require('../_alerts');

const SHEET_ID = process.env.SHOPIFY_ORDERS_SHEET;

const ORDERS_TAB  = 'orders';
const RETURNS_TAB = 'returns'; // matches sync-shopify-returns.js's tab name and headers: order_id, refund_id, refund_date, sku, quantity, refund_amount, note, brand, last_updated

// Order-type split — Skinuva-specific (2026-08-10, per Jaclyn). Sample
// orders ("S-") are intentionally NOT in this map — excluded from all
// revenue tracking, not just unassigned.
const ORDER_TYPES = [
  { key: 'customer',      prefix: 'C-', tab: 'revenue' },               // kept as the original tab name — this is what the dashboard's Customer tab + PDF export already read
  { key: 'physician',     prefix: 'P-', tab: 'revenue_physician' },
  { key: 'international', prefix: 'I-', tab: 'revenue_international' },
];

const REVENUE_HEADERS = ['MONTH', 'YEAR', 'REVENUE', 'UNITS ORDERED', 'LAST UPDATED'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SHEET_ID) {
    await sendCronFailureAlert('sync-shopify-revenue', 'SHOPIFY_ORDERS_SHEET not set');
    return res.status(500).json({ error: 'SHOPIFY_ORDERS_SHEET not set' });
  }

  const nowEst = toEstIso(new Date());

  // Determine current month and last month
  const today     = new Date();
  const currYear  = today.getUTCFullYear();
  const currMonth = today.getUTCMonth() + 1; // 1-indexed

  // 2026-07-16 — optional override: ?month=YYYY-MM processes ONLY that one
  // month instead of the normal current+previous window. Needed because
  // this script only ever recomputes the current+previous month relative
  // to whenever it runs — a month like May, once July starts, falls
  // permanently outside that window and can never self-heal again no
  // matter how many times the normal cron fires. This is how May gets
  // fixed by hand without waiting for (or faking) a different system
  // clock. Combined with the existing mis-keyed-row cleanup below, this
  // also removes May's corrupted "1905" row the same way it already
  // cleaned up June/July's. Default (unparameterized) behavior, used by
  // the actual scheduled cron trigger, is completely unchanged. Per
  // Jaclyn 2026-07-16.
  const monthOverride = req.query.month; // e.g. "2026-05"
  let targetKeys;
  if (monthOverride) {
    if (!/^\d{4}-\d{2}$/.test(monthOverride)) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format, e.g. 2026-05' });
    }
    targetKeys = new Set([monthOverride]);
    console.log(`[sync-shopify-revenue] month override active — processing ONLY ${monthOverride}, ignoring the normal current+previous window`);
  } else {
    let prevMonth = currMonth - 1;
    let prevYear  = currYear;
    if (prevMonth === 0) { prevMonth = 12; prevYear--; }
    targetKeys = new Set([
      `${currYear}-${String(currMonth).padStart(2,'0')}`,
      `${prevYear}-${String(prevMonth).padStart(2,'0')}`,
    ]);
  }

  console.log(`[sync-shopify-revenue] updating months: ${[...targetKeys].join(', ')}`);

  try {
    // ── 1. Read orders ──────────────────────────────────────────────────────
    let orderRows = [];
    try {
      orderRows = await readRows(SHEET_ID, ORDERS_TAB);
    } catch (e) {
      console.log('[sync-shopify-revenue] no orders tab yet, skipping');
      return res.status(200).json({ message: 'No orders tab found', timestamp: nowEst });
    }

    if (!orderRows.length) {
      return res.status(200).json({ message: '0 order rows', timestamp: nowEst });
    }

    // ── 2. Aggregate current + last month, split by order type ──────────────
    // monthMapByType[typeKey]["YYYY-MM"] = { revenue, units }
    const monthMapByType = {};
    ORDER_TYPES.forEach(t => { monthMapByType[t.key] = {}; });

    for (const row of orderRows) {
      // Skip refunded/cancelled
      const finStatus = (row.financial_status || row.status || '').toLowerCase().trim();
      if (finStatus === 'refunded' || finStatus === 'cancelled' || finStatus === 'canceled') continue;

      const date = normalizeDate(row.date);
      if (!date) continue;
      const key = date.substring(0, 7); // "YYYY-MM"
      if (!targetKeys.has(key)) continue;

      const skuUpper = (row.sku || '').trim().toUpperCase();
      const orderType = ORDER_TYPES.find(t => skuUpper.startsWith(t.prefix));
      if (!orderType) continue; // Sample ("S-") or unrecognized prefix — excluded entirely, not bucketed

      const monthMap = monthMapByType[orderType.key];
      if (!monthMap[key]) monthMap[key] = { revenue: 0, units: 0 };

      const price = parseFloat((row.item_price || '0').replace(/[$,]/g, '')) || 0;
      const units = parseInt(row.unit_count, 10) || 0;

      // item_price is already per-line so sum all lines
      monthMap[key].revenue += price;
      monthMap[key].units   += units;
    }

    const anyData = ORDER_TYPES.some(t => Object.keys(monthMapByType[t.key]).length > 0);
    if (!anyData) {
      console.log('[sync-shopify-revenue] no data for target months (any order type)');
      return res.status(200).json({ message: 'No data for target months', timestamp: nowEst });
    }

    // ── 2b. Net returns into the target month(s), per order type ───────────
    // Reuses targetKeys as-is, so this automatically respects the ?month=
    // override above — no separate handling needed.
    let returnRows = [];
    try {
      returnRows = await readRows(SHEET_ID, RETURNS_TAB);
    } catch (err) {
      console.warn('[sync-shopify-revenue] failed to read returns tab (revenue will NOT be netted against returns this run):', err.message);
    }

    for (const orderType of ORDER_TYPES) {
      const monthMap = monthMapByType[orderType.key];
      for (const key of Object.keys(monthMap)) {
        let returnedUnits = 0, returnedRevenue = 0;
        returnRows.forEach(r => {
          // Defensive brand filter — this sheet is Skinuva-only today (its
          // own dedicated Shopify file, not shared with évolis), but every
          // other returns/orders sheet in this repo filters by brand rather
          // than assuming a sheet stays single-tenant forever, and
          // sync-shopify-returns.js does write a real `brand` column to
          // check against. Costs nothing if it's always "skinuva" anyway.
          const brandVal = (r.brand || '').toString().trim().toLowerCase();
          if (brandVal && brandVal !== 'skinuva') return;
          // Order-type match — a Physician return must only net against
          // Physician revenue, never Customer's or International's.
          const returnSkuUpper = (r.sku || '').toString().trim().toUpperCase();
          if (!returnSkuUpper.startsWith(orderType.prefix)) return;
          const date = normalizeDate(r.refund_date);
          if (!date || date.substring(0, 7) !== key) return;
          returnedUnits   += parseInt(r.quantity, 10) || 0;
          returnedRevenue += parseFloat((r.refund_amount || '0').toString().replace(/[$,]/g, '')) || 0;
        });
        returnedRevenue = Math.round(returnedRevenue * 100) / 100;
        if (returnedUnits === 0 && returnedRevenue === 0) continue;

        const data = monthMap[key];
        const grossRevenue = data.revenue;
        const grossUnits   = data.units;
        data.revenue = Math.max(0, Math.round((grossRevenue - returnedRevenue) * 100) / 100);
        data.units   = Math.max(0, grossUnits - returnedUnits);

        console.log(`[sync-shopify-revenue] [${orderType.key}] ${key} — netted ${returnedUnits} returned units ($${returnedRevenue.toFixed(2)}) against gross revenue=${grossRevenue} units=${grossUnits}`);
        if (grossRevenue - returnedRevenue < 0 || grossUnits - returnedUnits < 0) {
          console.warn(`[sync-shopify-revenue] [${orderType.key}] ${key} — returns this month exceeded gross this month; floored at 0 rather than writing a negative value`);
        }
      }
    }

    // ── 3-5. For each order type: read existing rows, upsert target months,
    // write back — same logic as before, just wrapped to run three times. ──
    async function upsertRevenueTab(tabName, monthMap) {
      const tok = await ensureTab(SHEET_ID, tabName, REVENUE_HEADERS);
      let existingRows = [];
      try {
        existingRows = await readRows(SHEET_ID, tabName);
      } catch (e) { /* new tab */ }

      // Build map of existing rows keyed by "YYYY-MM"
      const existingMap = {};
      for (const r of existingRows) {
        const yr = String(r.YEAR  || r.year  || '').trim();
        const mo = String(r.MONTH || r.month || '').trim().padStart(2, '0');
        if (yr && mo) existingMap[`${yr}-${mo}`] = r;
      }

      // 2026-07-16 — root cause confirmed for the "YEAR shows 1905" bug seen
      // in this tab: column B (YEAR) has date-type cell formatting applied
      // somewhere along the way. Google Sheets stores dates as a serial
      // day-count from Dec 30, 1899 — and the literal integer 2026 (or
      // 2023-2027, i.e. any year this cron would ever write), reinterpreted
      // as that kind of serial number, lands on a date in mid-1905. Fix: for
      // each month this run is about to write a fresh, correct entry for,
      // first look for and delete any EXISTING row with a plausible MONTH
      // match but an implausible YEAR — same real month, stale mis-keyed
      // data — before adding the new one. Per Jaclyn 2026-07-16. See the
      // original évolis cron for the full historical writeup of this bug.
      let updatedCount = 0;
      for (const [key, data] of Object.entries(monthMap)) {
        const [yr, mo] = key.split('-');
        const yrNum = parseInt(yr, 10);

        Object.keys(existingMap).forEach(existingKey => {
          const [existingYr, existingMo] = existingKey.split('-');
          if (existingMo !== mo || existingKey === key) return;
          const existingYrNum = parseInt(existingYr, 10);
          const isImplausible = !existingYrNum || existingYrNum < yrNum - 15 || existingYrNum > yrNum + 2;
          if (isImplausible) {
            console.warn(`[sync-shopify-revenue] [${tabName}] removing stale mis-keyed row for month ${mo} (was under key "${existingKey}") — replacing with correctly-keyed "${key}"`);
            delete existingMap[existingKey];
          }
        });

        existingMap[key] = {
          MONTH:            parseInt(mo, 10),
          YEAR:             yrNum,
          REVENUE:          Math.round(data.revenue * 100) / 100,
          'UNITS ORDERED':  data.units,
          'LAST UPDATED':   nowEst,
        };
        updatedCount++;
      }

      const sortedKeys = Object.keys(existingMap).sort();
      const newRows = sortedKeys.map(key => {
        const r = existingMap[key];
        return [
          r.MONTH             || r.month  || '',
          r.YEAR              || r.year   || '',
          r.REVENUE           || r.revenue || 0,
          r['UNITS ORDERED']  || r.units  || 0,
          r['LAST UPDATED']   || r.last_updated || '',
        ];
      });

      await replaceRows(SHEET_ID, tabName, REVENUE_HEADERS, newRows, tok);
      console.log(`[sync-shopify-revenue] [${tabName}] ${updatedCount} months updated, ${newRows.length} total rows written`);
      return { updatedCount, totalRows: newRows.length };
    }

    const results = {};
    for (const orderType of ORDER_TYPES) {
      results[orderType.key] = await upsertRevenueTab(orderType.tab, monthMapByType[orderType.key]);
    }

    return res.status(200).json({
      results,
      timestamp: nowEst,
    });

  } catch (err) {
    console.error('[sync-shopify-revenue] error:', err.message);
    await sendCronFailureAlert('sync-shopify-revenue', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeDate(val) {
  if (!val) return '';
  if (/^\d{4}-\d{2}/.test(val)) return val.substring(0, 10);
  const parts = val.split('/');
  if (parts.length === 3) {
    const m = parts[0].padStart(2, '0');
    const d = parts[1].padStart(2, '0');
    const y = parts[2].length === 2 ? '20' + parts[2] : parts[2];
    return `${y}-${m}-${d}`;
  }
  return val;
}

function toEstIso(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`;
}
