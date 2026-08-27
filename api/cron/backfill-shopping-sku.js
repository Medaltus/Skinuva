/**
 * api/cron/backfill-shopping-sku.js
 * One-off backfill — patches sku on existing 'shopping' tab rows that were
 * written before the orders tab could resolve them.
 *
 * ROOT CAUSE (confirmed against the live sheet 2026-08-27): 727 shopping
 * rows for 2026-06-01 through 2026-07-31, covering all 12 recurring
 * item_ids, have sku=''. impressions, clicks, spend, conversions,
 * conversions_value, and acos on those rows are already correct — this was
 * never a Google Ads data problem. Those rows were bulk-pulled on
 * 2026-08-19, and at that moment the orders-tab shopify_item_id -> sku join
 * (the same one sync-google-ads.js's syncShoppingPerformance() uses)
 * couldn't fully resolve those item_ids yet. As of today the orders tab has
 * complete shopify_item_id + sku coverage for all 12 of them (checked
 * directly — 0 of the 727 blank rows are unresolvable now), so this is a
 * pure sheet-side repair. It deliberately does NOT call the Google Ads API —
 * no need to re-pull two months of historical ad data just to fix a join
 * that already has everything it needs sitting in the orders tab.
 *
 * SAFE TO RE-RUN: only touches rows where sku is currently blank AND the
 * item_id resolves in the orders map right now. Rows that already have a
 * sku are passed through unchanged. Rows whose item_id has genuinely never
 * appeared on a real order (advertised, never purchased) are left blank and
 * reported back explicitly, not guessed at.
 *
 * HEADS UP — unrelated to the backfill logic itself, but worth checking:
 * the live 'shopping' tab's sku column header is literally "SKU" (capital),
 * while sync-google-ads.js's SHOPPING_HEADERS array uses lowercase 'sku'.
 * If _sheets_client's readRows() does a strict case-sensitive header->key
 * match, that mismatch could cause the *daily* cron to blank out preserved
 * sku cells on rows outside its pull window on some future run — worth a
 * quick look at that file. This script reads tolerant of either casing and
 * always writes back a normalized 'sku' key, so it isn't exposed to that
 * risk either way.
 *
 * Trigger manually once (this is not meant to be added to vercel.json's
 * schedule — it's a single repair, not a recurring job):
 *
 *   curl -X POST https://<your-domain>/api/cron/backfill-shopping-sku \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Add ?dryRun=true first to preview counts with zero writes:
 *
 *   curl -X POST "https://<your-domain>/api/cron/backfill-shopping-sku?dryRun=true" \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Sheet: SHOPIFY_ORDERS_SHEET
 *   - Source: orders tab (shopify_item_id -> sku, read-only)
 *   - Target: shopping tab (sku column only — every other field untouched)
 */

const { ensureTab, replaceRows, readRows } = require('../config/_sheets_client');
const { sendCronFailureAlert }            = require('../_alerts');

const SHEET_ID = process.env.SHOPIFY_ORDERS_SHEET;

const ORDERS_TAB   = 'orders';
const SHOPPING_TAB = 'shopping';

// Must match sync-google-ads.js's SHOPPING_HEADERS exactly — same tab, same
// column order, sku last. Do not reorder: ensureTab() never rewrites an
// existing header row, so this only matters if the tab doesn't exist yet.
const SHOPPING_HEADERS = [
  'date', 'item_id', 'product_title', 'impressions', 'clicks',
  'spend', 'conversions', 'conversions_value', 'acos', 'last_updated', 'sku',
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SHEET_ID) {
    await sendCronFailureAlert('backfill-shopping-sku', 'SHOPIFY_ORDERS_SHEET not set');
    return res.status(500).json({ error: 'SHOPIFY_ORDERS_SHEET not set' });
  }

  const dryRun = req.query.dryRun === 'true';

  // ── 1. Build item_id -> sku map from the CURRENT orders tab — same join
  //       syncShoppingPerformance() uses in sync-google-ads.js. ────────────
  let orderRows;
  try {
    orderRows = await readRows(SHEET_ID, ORDERS_TAB);
  } catch (err) {
    console.error('[backfill-shopping-sku] failed to read orders tab:', err.message);
    await sendCronFailureAlert('backfill-shopping-sku', err.message, { Stage: 'Reading orders tab' });
    return res.status(500).json({ error: 'Failed to read orders tab', detail: err.message });
  }

  const skuByItemId = new Map();
  orderRows.forEach(r => {
    const itemId = r.shopify_item_id;
    if (itemId && r.sku && !skuByItemId.has(itemId)) skuByItemId.set(itemId, r.sku);
  });
  console.log(`[backfill-shopping-sku] resolved ${skuByItemId.size} distinct item_id -> sku pairs from orders`);

  // ── 2. Read the shopping tab and patch only rows where sku is blank and
  //       now resolvable. Tolerant of either 'sku' or 'SKU' on read; always
  //       normalizes to lowercase 'sku' on the way back out so a header
  //       casing mismatch can never silently wipe an existing value. ──────
  let token, shoppingRows;
  try {
    token        = await ensureTab(SHEET_ID, SHOPPING_TAB, SHOPPING_HEADERS);
    shoppingRows = await readRows(SHEET_ID, SHOPPING_TAB);
  } catch (err) {
    console.error('[backfill-shopping-sku] failed to read shopping tab:', err.message);
    await sendCronFailureAlert('backfill-shopping-sku', err.message, { Stage: 'Reading shopping tab' });
    return res.status(500).json({ error: 'Failed to read shopping tab', detail: err.message });
  }

  let backfilled = 0, alreadyHadSku = 0, stillUnresolved = 0;
  const unresolvedSample = [];

  const patchedRows = shoppingRows.map(r => {
    const existingSku = r.sku || r.SKU || '';
    if (existingSku) {
      alreadyHadSku++;
      return { ...r, sku: existingSku };
    }
    const resolved = skuByItemId.get(r.item_id);
    if (resolved) {
      backfilled++;
      return { ...r, sku: resolved };
    }
    stillUnresolved++;
    if (unresolvedSample.length < 10) {
      unresolvedSample.push({ date: r.date, item_id: r.item_id, product_title: r.product_title });
    }
    return { ...r, sku: '' };
  });

  console.log(`[backfill-shopping-sku] ${backfilled} backfilled, ${alreadyHadSku} already had sku, ${stillUnresolved} still unresolved`);

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      wouldBackfill: backfilled,
      alreadyHadSku,
      stillUnresolved,
      unresolvedSample,
    });
  }

  if (backfilled === 0) {
    return res.status(200).json({
      message: 'Nothing to backfill — no blank, resolvable sku rows found.',
      alreadyHadSku,
      stillUnresolved,
      unresolvedSample,
    });
  }

  // ── 3. Write back — full replace, same pattern sync-google-ads.js uses.
  //       Every row is passed through, not just the ones we touched, so
  //       column order and untouched values stay exactly as they were. ───
  const outputRows = patchedRows.map(r => SHOPPING_HEADERS.map(h => r[h] ?? ''));
  try {
    await replaceRows(SHEET_ID, SHOPPING_TAB, SHOPPING_HEADERS, outputRows, token);
  } catch (err) {
    console.error('[backfill-shopping-sku] failed to write shopping tab:', err.message);
    await sendCronFailureAlert('backfill-shopping-sku', err.message, { Stage: 'Writing shopping tab' });
    return res.status(500).json({ error: 'Failed to write shopping tab', detail: err.message });
  }

  return res.status(200).json({
    dryRun: false,
    backfilled,
    alreadyHadSku,
    stillUnresolved,
    unresolvedSample,
    totalRows: outputRows.length,
  });
};
