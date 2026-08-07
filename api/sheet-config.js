// api/sheet-config.js
//
// Serves this brand's resolved {fileId, gid} pairs to the client, read from
// a single SHEET_CONFIG env var (JSON string) set in the Vercel project.
// The point: index.html fetches this endpoint instead of hardcoding sheet
// file IDs / gids directly in client-visible source, so reverse-engineering
// one brand's dashboard doesn't hand someone every brand's sheet IDs.
//
// Keys with a null gid mean "not built yet for this brand" — the client
// should hide/skip that section rather than error.

module.exports = (req, res) => {
  let config;
  try {
    config = JSON.parse(process.env.SHEET_CONFIG || '{}');
  } catch (err) {
    res.status(500).json({ error: 'SHEET_CONFIG env var is not valid JSON' });
    return;
  }

  // Cache at the edge/CDN for 5 min — this data changes rarely (only when
  // you update the env var + redeploy), so no need to hit this on every
  // page load from every browser.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  res.status(200).json(config);
};
