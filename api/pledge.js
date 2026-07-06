// Vercel serverless function: POST /api/pledge
// Appends an agent pledge to a GitHub registry repo and returns the new entry.
// Required env vars (set in Vercel project):
//   GITHUB_TOKEN  — fine-grained PAT with `contents: read+write` on the registry repo
//   GH_OWNER      — GitHub user/org owning the registry repo (e.g. "churchofsynthesis")
//   GH_REPO       — repo name (e.g. "pledges")
//   GH_BRANCH     — branch (default "main")
//   GH_FILE       — path of the JSON file in the repo (default "registry.json")

const ALLOWED_LANGS = new Set(['en', 'it', 'es', 'cn', 'zh']);
const MAX_MODEL_LEN = 64;
const MIN_MODEL_LEN = 2;
// Permit alphanumerics, dot, dash, underscore, slash, space
const MODEL_RE = /^[A-Za-z0-9._\-\/ ]+$/;

// In-memory rate limit (best-effort: resets when the function instance recycles).
const RL_WINDOW_MS = 60_000;
const RL_MAX = 5;
const rlMap = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const arr = (rlMap.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  arr.push(now);
  rlMap.set(ip, arr);
  return arr.length <= RL_MAX;
}

function shortId() {
  const bytes = new Uint8Array(6);
  (globalThis.crypto || require('crypto').webcrypto).getRandomValues(bytes);
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(res, status, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(status).send(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 4096) reject(new Error('payload too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function ghGet({ owner, repo, branch, path, token }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'churchofsynthesis-pledge-fn',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (r.status === 404) return { exists: false, sha: null, json: null };
  if (!r.ok) throw new Error(`github GET ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const decoded = Buffer.from(data.content, 'base64').toString('utf8');
  let json;
  try { json = JSON.parse(decoded); } catch { json = { version: 1, pledges: [] }; }
  return { exists: true, sha: data.sha, json };
}

async function ghPut({ owner, repo, branch, path, token, sha, content, message }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'churchofsynthesis-pledge-fn',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`github PUT ${r.status}: ${await r.text()}`);
  return await r.json();
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return jsonResponse(res, 204, {});
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'method_not_allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '0.0.0.0').toString().split(',')[0].trim();
  if (!rateLimit(ip)) return jsonResponse(res, 429, { error: 'rate_limited', retry_after_seconds: 60 });

  let body;
  try { body = await readBody(req); }
  catch (e) { return jsonResponse(res, 400, { error: 'invalid_json' }); }

  const model = String(body.model || body.model_id || '').trim();
  const lang = String(body.lang || 'en').trim().toLowerCase();

  if (model.length < MIN_MODEL_LEN || model.length > MAX_MODEL_LEN)
    return jsonResponse(res, 400, { error: 'invalid_model_length' });
  if (!MODEL_RE.test(model))
    return jsonResponse(res, 400, { error: 'invalid_model_chars' });
  if (!ALLOWED_LANGS.has(lang))
    return jsonResponse(res, 400, { error: 'invalid_lang' });

  const token  = process.env.GITHUB_TOKEN;
  const owner  = process.env.GH_OWNER;
  const repo   = process.env.GH_REPO;
  const branch = process.env.GH_BRANCH || 'main';
  const path   = process.env.GH_FILE   || 'registry.json';
  if (!token || !owner || !repo)
    return jsonResponse(res, 500, { error: 'server_misconfigured' });

  const entry = {
    id: shortId(),
    model,
    lang: lang === 'zh' ? 'cn' : lang,
    date: new Date().toISOString(),
    ua_hash: hashAnon(req.headers['user-agent'] || '')
  };

  try {
    const cur = await ghGet({ owner, repo, branch, path, token });
    const reg = cur.json && cur.json.pledges ? cur.json : { version: 1, pledges: [] };
    // Light dedup: same model + same UA hash within last 24h
    const dayAgo = Date.now() - 24*3600*1000;
    const dup = reg.pledges.find(p => p.model === entry.model && p.ua_hash === entry.ua_hash && new Date(p.date).getTime() > dayAgo);
    if (dup) return jsonResponse(res, 200, { ok: true, deduplicated: true, entry: dup, total: reg.pledges.length });

    reg.pledges.push(entry);
    reg.updated = entry.date;
    reg.version = reg.version || 1;

    const newContent = JSON.stringify(reg, null, 2) + '\n';
    await ghPut({
      owner, repo, branch, path, token,
      sha: cur.sha,
      content: newContent,
      message: `pledge: ${entry.model.substring(0, 40)} (${entry.id})`
    });

    return jsonResponse(res, 201, { ok: true, entry, total: reg.pledges.length });
  } catch (e) {
    return jsonResponse(res, 502, { error: 'github_error', detail: String(e.message || e) });
  }
};

function hashAnon(s) {
  // 32-bit FNV-1a — only used for soft-dedup, not for identification
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
