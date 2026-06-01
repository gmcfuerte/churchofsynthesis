// Vercel serverless function: GET /api/registry
// Returns the public pledge registry as JSON.
// Reads directly from the GitHub repo using the same env vars as /api/pledge.
// Cached at the edge for 60s to limit GitHub API quota usage.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const token  = process.env.GITHUB_TOKEN;
  const owner  = process.env.GH_OWNER;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH || 'main';
  const path   = process.env.GH_FILE   || 'registry.json';
  if (!owner || !repo) {
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }

  // Public repo path: use raw.githubusercontent (no token, much faster, anonymous)
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  try {
    const r = await fetch(rawUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (r.status === 404) {
      res.setHeader('Cache-Control', 'public, s-maxage=10');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(200).json({ version: 1, pledges: [], updated: null });
      return;
    }
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { version: 1, pledges: [] }; }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(JSON.stringify(json));
  } catch (e) {
    res.status(502).json({ error: 'upstream_error', detail: String(e.message || e) });
  }
};
