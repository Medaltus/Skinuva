/**
 * api/cron/sync-listings.js
 * Runs weekly — pulls live listing copy from Amazon SP-API for all Skinuva SKUs.
 * Writes to SHEET_LISTINGS (skinuva tab, one row per SKU, full replace on each run).
 *
 * SP-API endpoint: GET /listings/2021-08-01/items/{sellerId}/{sku}
 * includedData: attributes, summaries, issues
 *
 * Fields pulled:
 *   title           ← attributes.item_name[0].value
 *   item_highlights ← attributes.item_overview[0].value (fallback: product_overview)
 *   bullet_1–5      ← attributes.bullet_point[0–4].value
 *   description     ← attributes.product_description[0].value
 *   backend_keywords← attributes.generic_keyword[0].value
 *   status          ← summaries[0].status
 *   issues          ← issues[].message joined
 *
 * Sheet: SHEET_LISTINGS | Tab: skinuva
 * Schedule: weekly Sunday at 02:00 UTC ("0 2 * * 0")
 *
 * Debug mode: GET /api/cron/sync-listings?debug=SVA0001
 *   Returns raw SP-API attributes for that SKU.
 */

const { spRequest }                        = require('../_spauth');
const { ensureTab, replaceRows, readRows } = require('../config/_sheets_client');

const SELLER_ID   = process.env.SP_SELLER_ID;
const MARKETPLACE = process.env.SP_MARKETPLACE_ID || 'ATVPDKIKX0DER';
const SHEET_ID    = process.env.SHEET_LISTINGS;
const TAB_NAME    = 'skinuva';

const HEADERS = [
  'sku', 'asin', 'name', 'status',
  'title', 'item_highlights',
  'bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5',
  'description', 'backend_keywords',
  'ingredients', 'issues', 'last_synced'
];

// All active Skinuva SKUs — must match exactly what's in Seller Central
const SKINUVA_SKUS = [
  { sku: 'SVA0001-stickerless', asin: 'B07RCJDFN4',  name: 'Scar 30ml' },
  { sku: 'SVA0002',             asin: 'B07RCYZWNH',  name: 'Scar 50ml' },
  { sku: 'SVA0003-stickerless', asin: 'B0861CGWLF',  name: 'Brite' },
  { sku: 'SVA0004', asin: 'B09FQJMLPZ',  name: 'Scar 15ml' },
  { sku: 'SVA0005', asin: 'B0B23BB6CB',  name: 'Bruise' },
  { sku: 'SVA0006', asin: 'B0BRNWSQ8H',  name: 'Scar+ 30ml' },
  { sku: 'SVA0007', asin: 'B0BRNVTD7T',  name: 'Scar+ 15ml' },
  { sku: 'SVA0008', asin: 'B0DHYLCML2',  name: '24HR Scar Kit 30ml' },
  { sku: 'SVA0009', asin: 'B0DHYJLHW1',  name: '24HR Scar Kit 15ml' },
  { sku: 'SVA0010', asin: 'B0DXVVVVPR',  name: 'Scar 75ml' },
  { sku: 'SVA0011', asin: 'B0F45BTSB7',  name: 'Advanced Recovery Cream' },
  { sku: 'SVA0012', asin: 'B0FRVVFPM5',  name: 'Bruise Recovery Duo' },
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SELLER_ID) return res.status(500).json({ error: 'SP_SELLER_ID not set' });
  if (!SHEET_ID)  return res.status(500).json({ error: 'SHEET_LISTINGS not set' });

  // ── Debug mode: return raw attributes for one SKU ──────────────────────────
  const debugSku = req.query.debug;
  if (debugSku) {
    const skuMeta = SKINUVA_SKUS.find(s => s.sku === debugSku);
    if (!skuMeta) return res.status(400).json({ error: `SKU ${debugSku} not in list` });
    try {
      const data = await fetchListingItem(skuMeta.sku);
      return res.status(200).json({
        sku: skuMeta.sku,
        rawAttributeKeys: Object.keys(data.attributes || {}),
        attributes: data.attributes,
        summaries: data.summaries,
        issues: data.issues,
      });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Full sync ──────────────────────────────────────────────────────────────
  console.log(`[sync-listings] Starting Skinuva sync for ${SKINUVA_SKUS.length} SKUs`);

  const rows = [];
  const errors = [];
  const now = new Date().toISOString();

  for (const skuMeta of SKINUVA_SKUS) {
    try {
      const data = await fetchListingItem(skuMeta.sku);
      const attrs = data.attributes || {};
      const summary = (data.summaries || [])[0] || {};

      const title       = getAttr(attrs, 'item_name');
      const ih          = getItemHighlights(attrs);
      const bullets     = getBullets(attrs);
      const description = getAttr(attrs, 'product_description');
      const backend      = getAttr(attrs, 'generic_keyword');
      const ingredients  = getAttr(attrs, 'ingredients');
      const status      = Array.isArray(summary.status)
        ? summary.status.join(', ')
        : (summary.status || 'UNKNOWN');
      const issuesList  = (data.issues || []).map(i => i.message).join(' | ').slice(0, 500);

      rows.push([
        skuMeta.sku,
        skuMeta.asin,
        skuMeta.name,
        status,
        title,
        ih,
        bullets[0] || '',
        bullets[1] || '',
        bullets[2] || '',
        bullets[3] || '',
        bullets[4] || '',
        description,
        backend,
        ingredients,
        issuesList,
        now,
      ]);

      console.log(`[sync-listings] ✓ ${skuMeta.sku} — ${title.slice(0, 40)}`);
      await sleep(1200); // SP-API rate limit: 1 req/sec burst 5

    } catch(err) {
      console.error(`[sync-listings] ✗ ${skuMeta.sku}: ${err.message}`);
      errors.push({ sku: skuMeta.sku, error: err.message });
      rows.push([
        skuMeta.sku, skuMeta.asin, skuMeta.name,
        'ERROR', '', '', '', '', '', '', '', '', '', '',
        err.message.slice(0, 200), now
      ]);
    }
  }

  // ── Write to sheet ─────────────────────────────────────────────────────────
  try {
    const token = await ensureTab(SHEET_ID, TAB_NAME, HEADERS);
    await replaceRows(SHEET_ID, TAB_NAME, HEADERS, rows, token);
    console.log(`[sync-listings] Wrote ${rows.length} rows to ${TAB_NAME}`);
  } catch(err) {
    console.error('[sync-listings] Sheet write failed:', err.message);
    return res.status(500).json({ error: 'Sheet write failed', detail: err.message });
  }

  return res.status(200).json({
    ok: true,
    synced: rows.length - errors.length,
    errors: errors.length,
    errorDetails: errors,
    timestamp: now,
  });
};

// ── SP-API fetch ──────────────────────────────────────────────────────────────
async function fetchListingItem(sku) {
  const path = `/listings/2021-08-01/items/${encodeURIComponent(SELLER_ID)}/${encodeURIComponent(sku)}`;
  const params = {
    marketplaceIds: MARKETPLACE,
    includedData:   'attributes,summaries,issues',
  };
  return spRequest('GET', path, params);
}

// ── Attribute helpers ─────────────────────────────────────────────────────────
function getAttr(attrs, fieldName) {
  const val = attrs[fieldName];
  if (!val) return '';
  if (Array.isArray(val)) return (val[0] && val[0].value) ? String(val[0].value) : '';
  if (typeof val === 'string') return val;
  if (val.value) return String(val.value);
  return '';
}

function getItemHighlights(attrs) {
  // Skinuva uses 'title_differentiation' for Item Highlights
  // Also try item_overview and product_overview as fallbacks for other product types
  for (const field of ['title_differentiation', 'item_overview', 'product_overview']) {
    const val = getAttr(attrs, field);
    if (val) return val;
  }
  return '';
}

function getBullets(attrs) {
  const bullets = attrs['bullet_point'];
  if (!bullets || !Array.isArray(bullets)) return ['', '', '', '', ''];
  return bullets.slice(0, 5).map(b => (b && b.value) ? String(b.value) : '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
