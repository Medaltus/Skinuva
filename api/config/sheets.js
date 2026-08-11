/**
 * api/config/sheets.js
 * Google Sheet IDs for each data type — Skinuva's repo.
 * Add new sheet IDs here as env vars — never hardcode them.
 *
 * This module is brand-agnostic by design (just names → env var values —
 * see config/brands.js for the actual brand-scoping via tabName), so it's
 * structurally identical to évolis's own copy. Kept the full list even
 * though Skinuva's own crons (run-analysis.js, run-listing-audit.js,
 * run-ppc-strategy-analysis.js) only actually read a subset of these —
 * harmless for the rest to resolve to undefined, and one less thing to
 * edit if a future Skinuva cron needs one of the others.
 *
 * ── Env var → sheet mapping ──────────────────────────────────────────────────
 * SHEET_ORDERS                    sync-orders (rolling 90-day cache, per-brand tabs)
 * SHEET_ORDERS_HISTORICAL         historical orders cache (YOY comparisons)
 * SHEET_PRODUCTS                  master SKU/ASIN sheet (Vine tab lives here)
 * SHEET_ADVERTISING               advertising cache (ad summary + ad orders tabs)
 * SHEET_SUBSCRIPTIONS             subscribe & save sync
 * SHEET_REVENUE                   revenue history (monthly totals by brand)
 * SHEET_RETURNS                   FBA customer returns (sync-returns-request/process)
 * SHEET_AD_ORDERS                 ad orders cache (ASIN-level ad performance)
 * SHEET_LISTING_AUDIT             listing audit results (per-brand tabs) — used by run-listing-audit.js
 * SHEET_KEYWORD_STRATEGY          keyword strategy per brand
 * SHEET_INSIGHTS                  brand insights / monthly takeaways — used by run-analysis.js
 * SHEET_UPLOADS                   file uploads tracking (per-brand GID)
 * SHEET_BUSINESS_REPORT           Sales & Traffic business report (sessions/units by brand, monthly) — used by run-analysis.js, run-ppc-strategy-analysis.js
 * SHEET_SEARCH_QUERY_PERFORMANCE  Brand Analytics Search Query Performance (full monthly report, per-brand tabs) — used by run-analysis.js
 * SHEET_MASTER_SKU_LIST           Master SKU/ASIN list across all brands (Product Short Name tab)
 * SHEET_KEYWORD_TRACKER            Organic keyword rank tracking, per-brand tabs — used by run-analysis.js
 * SHEET_CONSIGNMENT_INVENTORY      Consignment inventory from ShipStation V2, per-brand tabs
 * SHEET_FULFILLMENT_DAILY_SHIPMENTS Daily shipped-order counts (chart) + _kpis tab
 * SHEET_FULFILLMENT_STATES          Orders-by-state snapshot for the Fulfillment page's US map + table
 * SHEET_CUSTOMER_SERVICE            Reviews Requested (H10 Follow Up, automated) + Compliance Cases (manual), one tab per brand
 * SHEET_PRODUCT_INVENTORY            Dated daily product+inventory snapshots, per-brand tabs — used by run-listing-audit.js, run-analysis.js
 * SHEET_NEWDERM_INVENTORY            Regular (non-consignment) inventory reconciliation report — marketplace vs Cin7 Core by location
 * SHEET_WALMART_RETURNS              Walmart return orders (dedicated Returns API), one tab per brand
 * SHEET_REPORT_INSIGHTS               Editable report content for the internal dashboard (Executive Summary, Key Insights, Opportunity cards) + approval status. NOT the same sheet as SHEET_INSIGHTS above.
 */

module.exports = {
  orders:                 process.env.SHEET_ORDERS,
  ordersHistorical:       process.env.SHEET_ORDERS_HISTORICAL,
  products:               process.env.SHEET_PRODUCTS,
  advertising:            process.env.SHEET_ADVERTISING,
  subscriptions:          process.env.SHEET_SUBSCRIPTIONS,
  revenue:                process.env.SHEET_REVENUE,
  returns:                process.env.SHEET_RETURNS,
  adOrders:               process.env.SHEET_AD_ORDERS,
  listingAudit:           process.env.SHEET_LISTING_AUDIT,
  keywordStrategy:        process.env.SHEET_KEYWORD_STRATEGY,
  insights:               process.env.SHEET_INSIGHTS,
  reportInsights:         process.env.SHEET_REPORT_INSIGHTS,
  uploads:                process.env.SHEET_UPLOADS,
  businessReport:         process.env.SHEET_BUSINESS_REPORT,
  searchQueryPerformance: process.env.SHEET_SEARCH_QUERY_PERFORMANCE,
  masterSkuList:          process.env.SHEET_MASTER_SKU_LIST,
  keywordTracker:         process.env.SHEET_KEYWORD_TRACKER,
  consignmentInventory:   process.env.SHEET_CONSIGNMENT_INVENTORY,
  fulfillmentDailyShipments: process.env.SHEET_FULFILLMENT_DAILY_SHIPMENTS,
  fulfillmentStates:         process.env.SHEET_FULFILLMENT_STATES,
  customerService:           process.env.SHEET_CUSTOMER_SERVICE,
  productInventory:          process.env.SHEET_PRODUCT_INVENTORY,
  newdermInventory:          process.env.SHEET_NEWDERM_INVENTORY,
  walmartReturns:            process.env.SHEET_WALMART_RETURNS,
};
