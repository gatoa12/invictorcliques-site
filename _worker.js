// Cloudflare Worker — entrada principal do site invictorcliques
// Serve o site (arquivos estáticos) e responde às rotas /api/*.
// À prova de falha: se qualquer /api/ der erro, o site continua no ar.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/data")        return await handleData(request, env);
      if (path === "/api/gist")        return await handleGist(request, env);
      if (path === "/api/marketplace") return await handleMarketplace(request, env);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
    // Qualquer outra coisa = arquivos estáticos do site
    return env.ASSETS.fetch(request);
  },
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-admin-key",
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...CORS } });
}

// ── /api/data — armazenamento no KV (leitura pública; escrita só admin) ──
async function handleData(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const KEY = "site_data";
  if (request.method === "GET") {
    const val = await env.INV_KV.get(KEY);
    return new Response(val || "{}", { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } });
  }
  if (request.method === "POST") {
    const provided = request.headers.get("x-admin-key") || "";
    if (!env.ADMIN_WRITE_KEY || provided !== env.ADMIN_WRITE_KEY) return json({ error: "unauthorized" }, 403);
    const body = await request.text();
    JSON.parse(body);
    await env.INV_KV.put(KEY, body);
    return json({ ok: true, savedAt: Date.now() });
  }
  return json({ error: "method_not_allowed" }, 405);
}

// ── /api/gist — proxy do GitHub Gist ──────────────────────────────
const GH = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "invictorcliques-sync" };
async function handleGist(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const u = new URL(request.url);
  const id = (u.searchParams.get("id") || "").trim();
  if (!id) return json({ error: "Falta o id do gist." }, 400);
  if (request.method === "GET") {
    const r = await fetch("https://api.github.com/gists/" + id, { headers: GH });
    const text = await r.text();
    return new Response(text, { status: r.ok ? 200 : r.status, headers: { "content-type": "application/json", ...CORS } });
  }
  if (request.method === "POST") {
    const TOKEN = env.GIST_TOKEN || "";
    if (!TOKEN) return json({ error: "GIST_TOKEN não configurado." }, 500);
    let body = await request.text();
    try { body = JSON.parse(body); } catch (e) { body = {}; }
    if (!body || !body.files) return json({ error: "Falta o campo files." }, 400);
    const r = await fetch("https://api.github.com/gists/" + id, { method: "PATCH", headers: { ...GH, "Authorization": "token " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ files: body.files }) });
    const j = await r.json();
    return json({ ok: r.ok, id: j.id || id }, r.ok ? 200 : r.status);
  }
  return json({ error: "method_not_allowed" }, 405);
}

// ── /api/marketplace — busca de produtos ──────────────────────────
async function handleMarketplace(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").trim();
  const source = (u.searchParams.get("source") || "mercadolivre").trim();
  const limit = Math.min(parseInt(u.searchParams.get("limit") || "6", 10) || 6, 20);
  if (!q) return json({ results: [], error: "Falta o parâmetro q." }, 400);
  let results = [];
  if (source === "mercadolivre") results = await searchML(q, limit, env);
  else if (source === "shopee")  results = await searchShopee(q, limit, env);
  else return json({ results: [], error: "source inválido: " + source }, 400);
  return json({ source, results });
}
async function searchML(q, limit, env) {
  const r = await fetch("https://api.mercadolibre.com/sites/MLB/search?q=" + encodeURIComponent(q) + "&limit=" + limit);
  if (!r.ok) throw new Error("Mercado Livre " + r.status);
  const j = await r.json();
  const aff = env.ML_AFFILIATE || "";
  return (j.results || []).map((it) => ({ title: it.title, price: it.price, img: String(it.thumbnail || "").replace(/^http:/, "https:").replace("-I.jpg", "-O.jpg"), link: aff ? addParam(it.permalink, "matt_word", aff) : it.permalink, source: "Mercado Livre" }));
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function searchShopee(q, limit, env) {
  const appId = env.SHOPEE_APP_ID || "", secret = env.SHOPEE_SECRET || "";
  if (!appId || !secret) throw new Error("Shopee não configurada.");
  const endpoint = "https://open-api.affiliate.shopee.com.br/graphql";
  const query = `{ productOfferV2(keyword: "${q.replace(/"/g, '\\"')}", limit: ${limit}, page: 1) { nodes { productName price imageUrl offerLink } } }`;
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const sign = await sha256Hex(appId + ts + payload + secret);
  const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", Authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${sign}` }, body: payload });
  if (!r.ok) throw new Error("Shopee " + r.status);
  const j = await r.json();
  const nodes = (((j.data || {}).productOfferV2 || {}).nodes) || [];
  return nodes.map((n) => ({ title: n.productName, price: Number(n.price), img: n.imageUrl, link: n.offerLink, source: "Shopee" }));
}
function addParam(url, k, v) { try { const u = new URL(url); u.searchParams.set(k, v); return u.toString(); } catch (e) { return url; } }
