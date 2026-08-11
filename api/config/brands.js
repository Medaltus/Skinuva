/**
 * api/config/brands.js
 * Brand registry for Skinuva's own repo.
 *
 * Unlike évolis's repo (which shares one Amazon seller account across ~15
 * Medaltus brands and needs the full registry for crons that loop over
 * every active brand in one run), Skinuva's repo only ever processes
 * Skinuva itself — the "Run Analysis" / "Run Listing Audit" / "Run PPC
 * Analysis" buttons on Skinuva's own dashboard always call these
 * endpoints with { brand: "skinuva" }. A single-entry array is
 * intentional here, not a placeholder to fill in later.
 *
 * skuPrefix:       first 3 chars of all SKUs for this brand
 * tabName:         slug used as the Google Sheet tab name — this is what
 *                   every readRows/ensureTab/appendRows call in
 *                   run-analysis.js, run-listing-audit.js, and
 *                   run-ppc-strategy-analysis.js uses to select which
 *                   brand's tab to read/write on each shared,
 *                   multi-brand sheet (Business Report, Insights,
 *                   Listing Audit, etc.) — so this MUST exactly match
 *                   the "skinuva" tab name already used on those sheets
 *                   (confirmed against the frontend dashboard's own
 *                   SHEET_CONFIG work, which reads the same tabs).
 * active:          set false to pause without deleting config.
 * amazonBrandName: EXACT string as registered in Amazon Brand Registry,
 *                   ALL CAPS. Copied from évolis's brands.js entry for
 *                   Skinuva — not independently re-verified against
 *                   Brand Registry this session, but that file's own
 *                   entry was itself already confirmed correct
 *                   elsewhere in this project.
 */
module.exports = [
  {
    id:              'skinuva',
    tabName:         'skinuva',
    skuPrefix:       'SVA',
    displayName:     'Skinuva',
    amazonBrandName: 'SKINUVA',
    active:          true,
  },
];
