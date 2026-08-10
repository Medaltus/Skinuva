/**
 * api/cron/sync-shopify-subscriptions.js
 * Daily — counts ACTIVE subscriptions via Seal Subscriptions' own REST API
 * and writes that single number into column L ("website_subscriptions") of
 * the current month's row on the Stewardship Summary sheet.
 *
 * REWRITTEN for Skinuva (2026-08-10) — évolis's original version queries
 * Shopify's native GraphQL `subscriptionContracts` connection, which works
 * for évolis because its subscriptions app (Appstle) is built directly on
 * top of Shopify's native Subscription Contract objects. Skinuva uses a
 * DIFFERENT app — Seal Subscriptions — which maintains its own entirely
 * separate data model, exposed only through Seal's own dedicated REST API
 * (app.sealsubscriptions.com), never through Shopify's native GraphQL
 * objects at all. CONFIRMED REAL INCIDENT: running évolis's original
 * GraphQL-based version against Skinuva returned 0 active subscriptions
 * every time, even though Seal's own dashboard showed 83 active — not a
 * status-filtering bug, just querying the wrong API entirely.
 *
 * Auth: Seal's API uses its own token, sent as the X-Seal-Token header.
 * Found in Shopify Admin → Apps → Seal Subscriptions → Settings → General
 * Settings → API. This is a SEPARATE credential from
 * SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET — Seal's API lives on Seal's own
 * servers, not Shopify's, so Shopify's own app credentials don't apply.
 *
 * IMPORTANT — RESPONSE SHAPE NOT YET VERIFIED AGAINST REAL DATA: built
 * from Seal's published docs (sealsubscriptions.com/articles/
 * merchant-api-documentation), which show a full sample response for the
 * single-subscription endpoint (GET /subscription?id=...) but not the
 * *list* endpoint (GET /subscriptions) used here. Assumed shape:
 * { success: true, payload: [ {...}, ... ] }, each item carrying at least
 * an `id` field (used only to count array length, not any other field).
 * The response this endpoint returns includes `sampleFirstItem` — the
 * first real subscription object fetched — specifically so this can be
 * verified against Skinuva's actual data on the first real run. Remove
 * that field from the response once confirmed correct.
 *
 * Paginates with ?active-only=true&page=N, 50 results per page per Seal's
 * docs, stopping when a page comes back with fewer than 50 (last page).
 * Sequential requests only (never more than 1 in flight) — Seal's stated
 * rate limit is 10 concurrent requests per token, so this comfortably
 * stays under that regardless of how many subscriptions exist.
 *
 * Everything else — writing ONLY column L of the current month's row,
 * never touching columns A-K or any other row — is unchanged from
 * évolis's version. See that file's own comments for why this cron is
 * scoped so narrowly.
 *
 * Sheet: SHEET_STEWARDSHIP_SUMMARY (16QNnDh7-dTDzI-O7UI-WlzMtOmovssV23nd-quiYPR0)
 *   — same shared, multi-brand file every brand's dashboard already reads
 *   from, NOT a new Skinuva-specific sheet.
 * Tab: 'skinuva'
 * Schedule: daily, "30 7 * * *" — same stagger as Skinuva's other 3
 *   Shopify crons (orders 7:00, revenue 7:07, returns 7:22 UTC).
 */

const { ensureTab, readRows, replaceRows } = require('../config/_sheets_client');

const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;
const SEAL_API_BASE  = 'https://app.sealsubscriptions.com/shopify/merchant/api';

const SUMMARY_SHEET_ID = process.env.SHEET_STEWARDSHIP_SUMMARY;
const TAB_NAME          = 'skinuva'; // matches brand.tabName used by sync-stewardship-summary.js — the SAME shared multi-brand Stewardship Summary file every brand uses, just Skinuva's own tab within it

// Full header list INCLUDING column L. Must match exactly what
// sync-stewardship-summary.js uses, or the two crons will disagree about
// which column index is which.
const HEADERS = [
  'year', 'month',
  'ads_spend', 'impressions', 'clicks', 'ad_units',
  'promos_total', 'vine_total',
  'revenue', 'units',
  'last_updated',
  'website_subscriptions', // column L — the ONLY column this cron writes
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SEAL_API_TOKEN) {
    return res.status(500).json({ error: 'SEAL_API_TOKEN not set' });
  }
  if (!SUMMARY_SHEET_ID) {
    return res.status(500).json({ error: 'SHEET_STEWARDSHIP_SUMMARY not set' });
  }

  // ── Count ACTIVE subscriptions, paging through Seal's REST API ───────────
  let activeCount = 0;
  let page = 0;
  let sampleFirstItem = null;

  do {
    page++;
    let resp, data;
    try {
      resp = await fetch(`${SEAL_API_BASE}/subscriptions?active-only=true&page=${page}`, {
        headers: { 'Content-Type': 'application/json', 'X-Seal-Token': SEAL_API_TOKEN },
      });
      data = await resp.json();
    } catch (err) {
      console.error(`[sync-shopify-subscriptions] page ${page} request failed:`, err.message);
      return res.status(500).json({ error: 'Seal API request failed', detail: err.message, page });
    }

    if (!resp.ok || data?.success === false) {
      console.error(`[sync-shopify-subscriptions] page ${page} error:`, resp.status, JSON.stringify(data));
      return res.status(500).json({ error: 'Seal API returned an error', status: resp.status, detail: data, page });
    }

    const items = Array.isArray(data?.payload) ? data.payload : [];
    if (page === 1 && items.length) sampleFirstItem = items[0];

    activeCount += items.length;
    console.log(`[sync-shopify-subscriptions] page ${page}: +${items.length} (running total: ${activeCount})`);

    if (items.length < 50) break; // fewer than a full page — this was the last one
    if (page >= 200) { console.warn('[sync-shopify-subscriptions] hit page cap'); break; }
  } while (true);

  console.log(`[sync-shopify-subscriptions] total ACTIVE subscriptions: ${activeCount}`);

  // ── Write ONLY column L for the current year/month row ────────────────────
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  try {
    const token = await ensureTab(SUMMARY_SHEET_ID, TAB_NAME, HEADERS);
    const existing = await readRows(SUMMARY_SHEET_ID, TAB_NAME);

    let found = false;
    const updated = existing.map(r => {
      const rowCopy = { ...r };
      if (parseInt(r.year, 10) === year && parseInt(r.month, 10) === month) {
        rowCopy.website_subscriptions = activeCount;
        found = true;
      }
      return rowCopy;
    });

    if (!found) {
      // No row for this month yet — add one with ONLY
      // year/month/website_subscriptions filled, everything else blank
      // rather than guessed at.
      const blankRow = {};
      HEADERS.forEach(h => { blankRow[h] = ''; });
      blankRow.year = year;
      blankRow.month = month;
      blankRow.website_subscriptions = activeCount;
      updated.push(blankRow);
      console.log(`[sync-shopify-subscriptions] no existing row for ${year}-${month} — created one with only year/month/website_subscriptions set`);
    }

    const outRows = updated.map(r => HEADERS.map(h => r[h] ?? ''));
    await replaceRows(SUMMARY_SHEET_ID, TAB_NAME, HEADERS, outRows, token);

    return res.status(200).json({
      activeSubscriptions: activeCount,
      year, month,
      rowFoundExisting: found,
      pagesFetched: page,
      sampleFirstItem, // TEMPORARY — verify this matches real Seal data, then remove
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[sync-shopify-subscriptions] sheet write failed:', err.message);
    return res.status(500).json({ error: 'Sheet write failed', detail: err.message });
  }
};
