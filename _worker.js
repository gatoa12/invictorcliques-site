// Cloudflare Worker — entrada principal do site invictorcliques
// Serve o site (arquivos estáticos) e responde às rotas /api/*.
// À prova de falha: se qualquer /api/ der erro, o site continua no ar.
//
// ✨ NOVO (v251): atualização AUTOMÁTICA dos eventos do Foco Radical.
//   - scheduled(): roda sozinho no horário do cron (ver wrangler.jsonc),
//     busca o portal, lê os eventos e grava na nuvem (KV) — sem ninguém fazer nada.
//   - /api/refresh-foco: dispara a mesma atualização na hora (botão do admin).

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/data")         return await handleData(request, env);
      if (path === "/api/gist")         return await handleGist(request, env);
      if (path === "/api/marketplace")  return await handleMarketplace(request, env);
      if (path === "/api/refresh-foco") return await handleRefreshFoco(request, env);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
    // Qualquer outra coisa = arquivos estáticos do site
    return env.ASSETS.fetch(request);
  },

  // ⏰ Roda automaticamente no horário definido no cron (wrangler.jsonc).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateFocoFromPortal(env).catch(() => {}));
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

// ══════════════════════════════════════════════════════════════════
//  ATUALIZAÇÃO AUTOMÁTICA DOS EVENTOS DO FOCO RADICAL
// ══════════════════════════════════════════════════════════════════
const FOCO_PORTAL = "https://invictorcliques.focoradical.com.br/";

// Converte os eventos do portal pro formato do site
function _focoMapEvents(comps) {
  const dias = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  return (comps || []).map((c) => {
    const parts = String(c.date || "").split("-").map(Number);
    const y = parts[0], mo = parts[1], d = parts[2];
    const dateBR = String(d).padStart(2, "0") + "/" + String(mo).padStart(2, "0") + "/" + y;
    let dia = "";
    try { dia = dias[new Date(y, mo - 1, d).getDay()]; } catch (e) {}
    let hour = 20;
    try { hour = parseInt(String(c.launch_date).split(" ")[1].split(":")[0], 10); } catch (e) {}
    const name = String(c.name || "");
    let periodo = "Noite";
    if (/MANH/i.test(name)) periodo = "Manhã";
    else if (/TREIN[ÃA]O/i.test(name)) periodo = "Treinão";
    else if (/TARDE\/NOITE/i.test(name)) periodo = "Tarde/Noite";
    else if (hour < 12) periodo = "Manhã";
    else if (hour < 18) periodo = "Tarde/Noite";
    const img = c.coverPhotoOrIcon && c.coverPhotoOrIcon.image;
    const banner = (img && img.indexOf("/banners/") >= 0) ? img : null;
    return {
      title: name,
      subtitle: periodo,
      date: dateBR,
      dia: dia,
      periodo: periodo,
      url: "https://invictorcliques.focoradical.com.br/prova/" + c.path,
      banner: banner,
    };
  });
}

function _parseBR(s) {
  const p = String(s || "").split("/");
  return p.length === 3 ? new Date(+p[2], +p[1] - 1, +p[0]).getTime() : 0;
}

// Busca o portal, lê os eventos e grava na nuvem (mesclando com os que já existem)
async function updateFocoFromPortal(env) {
  const res = await fetch(FOCO_PORTAL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; invictorcliques-bot)" },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) return { ok: false, reason: "portal HTTP " + res.status };
  const html = await res.text();
  const m = html.match(/<script id="dto"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { ok: false, reason: "dto não encontrado" };
  let dto;
  try { dto = JSON.parse(m[1]); } catch (e) { return { ok: false, reason: "json inválido" }; }
  const comps = (dto && dto.pageData && dto.pageData.competitions) || [];
  if (!comps.length) return { ok: false, reason: "sem eventos" };
  const novos = _focoMapEvents(comps);

  // lê o blob atual da nuvem
  const KEY = "site_data";
  let blob = {};
  try { blob = JSON.parse((await env.INV_KV.get(KEY)) || "{}"); } catch (e) { blob = {}; }
  let existentes = [];
  try { existentes = JSON.parse(blob.focoEventosReais || "[]"); } catch (e) { existentes = []; }

  // mescla por URL (novos têm prioridade), remove duplicados
  const byUrl = {};
  novos.concat(existentes).forEach((e) => { if (e && e.url && !byUrl[e.url]) byUrl[e.url] = e; });
  let merged = Object.keys(byUrl).map((k) => byUrl[k]);
  merged.sort((a, b) => _parseBR(b.date) - _parseBR(a.date));
  merged = merged.slice(0, 60); // guarda no máximo 60 (os mais recentes)

  const jsonStr = JSON.stringify(merged);
  blob.focoEventosReais = jsonStr;
  blob.focoEventosReais_v46 = jsonStr;
  blob._lastUpdate = String(Date.now());
  await env.INV_KV.put(KEY, JSON.stringify(blob));
  return { ok: true, total: merged.length, novosNoPortal: novos.length };
}

// ── /api/refresh-foco — dispara a atualização na hora (botão do admin) ──
async function handleRefreshFoco(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const result = await updateFocoFromPortal(env);
  return json(result, result.ok ? 200 : 502);
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
