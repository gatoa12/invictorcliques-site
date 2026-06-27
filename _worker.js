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

    // ✅ UM SITE SÓ: redireciona www → sem-www (evita o efeito "dois sites").
    // Tudo passa a viver em invictorcliques.com.br (canônico). Redirect SEM cache,
    // pra nunca ficar preso numa versão antiga.
    if (url.hostname.startsWith("www.")) {
      const dest = new URL(request.url);
      dest.hostname = url.hostname.replace(/^www\./, "");
      return new Response(null, {
        status: 301,
        headers: {
          "Location": dest.toString(),
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "CDN-Cache-Control": "no-store",
          "Cloudflare-CDN-Cache-Control": "no-store"
        }
      });
    }

    try {
      if (path === "/api/data")         return await handleData(request, env);
      if (path === "/api/gist")         return await handleGist(request, env);
      if (path === "/api/marketplace")  return await handleMarketplace(request, env);
      if (path === "/api/shopee")       return await handleShopee(request, env, url);
      if (path === "/api/ai")           return await handleAI(request, env);
      if (path === "/api/visit")        return await handleVisit(request, env);
      if (path === "/api/refresh-foco") return await handleRefreshFoco(request, env);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }

    // Qualquer outra coisa = arquivos estáticos do site.
    // 🔄 Pra o site SEMPRE pegar a versão nova (sem ficar "preso" no cache),
    // o HTML é servido com no-cache. Imagens/JS continuam com cache normal.
    const res = await env.ASSETS.fetch(request);
    try {
      const ctype = res.headers.get("content-type") || "";
      if (ctype.includes("text/html")) {
        const h = new Headers(res.headers);
        // no-cache = o navegador GUARDA o site mas revalida sempre (304 = rápido quando nada mudou,
        // e baixa de novo só quando você publica algo). Rápido E sempre atualizado.
        h.set("Cache-Control", "no-cache, must-revalidate");
        h.set("CDN-Cache-Control", "no-cache");
        h.set("Cloudflare-CDN-Cache-Control", "no-cache");
        h.set("Pragma", "no-cache");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
      }
    } catch (e) {}
    return res;
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

// ── /api/visit — conta visitantes do site (total + hoje) ──
async function handleVisit(request, env) {
  try {
    const KV = env.INV_KV;
    if (!KV) return json({ total: 0, today: 0 }, 200);
    const today = new Date().toISOString().slice(0, 10); // AAAA-MM-DD
    let raw = await KV.get("inv_visits");
    let v = {};
    try { v = raw ? JSON.parse(raw) : {}; } catch (e) { v = {}; }
    if (typeof v.total !== "number") v.total = 0;
    if (v.day !== today) { v.day = today; v.today = 0; }
    // só conta de verdade num GET sem ?peek (peek = só leitura, pro admin)
    var peek = false;
    try { peek = new URL(request.url).searchParams.get("peek") === "1"; } catch (e) {}
    if (request.method === "GET" && !peek) {
      v.total += 1;
      v.today = (v.today || 0) + 1;
      try { await KV.put("inv_visits", JSON.stringify(v)); } catch (e) {}
    }
    return new Response(JSON.stringify({ total: v.total, today: v.today, day: v.day }), {
      headers: { "content-type": "application/json", "cache-control": "no-store", "CDN-Cache-Control": "no-store", ...CORS }
    });
  } catch (e) {
    return json({ total: 0, today: 0, error: String((e && e.message) || e) }, 200);
  }
}

// ── /api/ai — IA estável pelo servidor (Pollinations + Anthropic de reserva) ──
async function handleAI(request, env) {
  if (request.method !== "POST") return json({ text: "", error: "use POST" }, 200);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = body.system || "";
  const maxTokens = body.max_tokens || 450;
  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  messages.forEach(function (m) { msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }); });
  // 1) Pollinations (lado do servidor — sem CORS, sem limite de URL)
  try {
    const r = await fetch("https://text.pollinations.ai/openai", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai", messages: msgs, private: true })
    });
    if (r.ok) {
      const j = await r.json();
      const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (t && String(t).trim()) return json({ text: String(t).trim() }, 200);
    }
  } catch (e) {}
  // 2) Anthropic (se a chave estiver configurada no Worker)
  try {
    const akey = env.ANTHROPIC_API_KEY;
    if (akey) {
      const ar = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": akey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-3-5-haiku-20241022", max_tokens: maxTokens, system: system || undefined, messages: messages })
      });
      if (ar.ok) {
        const aj = await ar.json();
        const t = (aj.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n").trim();
        if (t) return json({ text: t }, 200);
      }
    }
  } catch (e) {}
  return json({ text: "", error: "ai_unavailable" }, 200);
}

// ── /api/shopee — config segura + busca de tênis com link de afiliado ──
// As chaves (App ID/Secret/Affiliate ID) ficam no KV numa chave SEPARADA
// ("shopee_cfg") que NUNCA é devolvida pelo /api/data público. O Secret
// só é usado aqui dentro (servidor) pra assinar as chamadas à Shopee.
const SHOPEE_CFG_KEY = "shopee_cfg";
const SHOPEE_GQL = "https://open-api.affiliate.shopee.com.br/graphql";

async function _sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function _shopeeCfg(env) {
  try { const v = await env.INV_KV.get(SHOPEE_CFG_KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

async function handleShopee(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const action = (url.searchParams.get("action") || "").toLowerCase();

  // Salvar/atualizar as chaves (só admin)
  if (request.method === "POST" && action === "config") {
    const provided = request.headers.get("x-admin-key") || "";
    if (!env.ADMIN_WRITE_KEY || provided !== env.ADMIN_WRITE_KEY) return json({ error: "unauthorized" }, 403);
    let body = {};
    try { body = JSON.parse(await request.text()); } catch (e) { return json({ error: "bad_json" }, 400); }
    const cfg = {
      appId: String(body.appId || "").trim(),
      secret: String(body.secret || "").trim(),
      affId: String(body.affId || "").trim(),
      savedAt: Date.now(),
    };
    await env.INV_KV.put(SHOPEE_CFG_KEY, JSON.stringify(cfg));
    return json({ ok: true, configured: !!(cfg.appId && cfg.secret) });
  }

  // Apagar as chaves (só admin)
  if (request.method === "POST" && action === "clear") {
    const provided = request.headers.get("x-admin-key") || "";
    if (!env.ADMIN_WRITE_KEY || provided !== env.ADMIN_WRITE_KEY) return json({ error: "unauthorized" }, 403);
    await env.INV_KV.delete(SHOPEE_CFG_KEY);
    return json({ ok: true, configured: false });
  }

  // Status (NÃO devolve o Secret — só diz se está configurado)
  if (action === "status") {
    const cfg = await _shopeeCfg(env);
    const appId = cfg && cfg.appId ? cfg.appId : "";
    const masked = appId ? (appId.slice(0, 4) + "•••" + appId.slice(-3)) : "";
    return json({ configured: !!(cfg && cfg.appId && cfg.secret), appIdMasked: masked, affId: (cfg && cfg.affId) || "", savedAt: (cfg && cfg.savedAt) || 0 });
  }

  // Busca de produtos (tênis) já com o link de afiliado
  if (action === "search") {
    const cfg = await _shopeeCfg(env);
    if (!cfg || !cfg.appId || !cfg.secret) return json({ configured: false, items: [], note: "Shopee ainda não configurada no painel." });
    const q = (url.searchParams.get("q") || "tênis de corrida").slice(0, 80);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "6", 10) || 6, 20);
    // GraphQL: busca ofertas de produto com link de afiliado embutido
    const query = `{"query":"{ productOfferV2(keyword: \\"${q.replace(/"/g, "")}\\", limit: ${limit}, sortType: 2) { nodes { productName priceMin priceMax imageUrl offerLink commissionRate ratingStar } } }"}`;
    const ts = Math.floor(Date.now() / 1000);
    const signature = await _sha256hex(cfg.appId + ts + query + cfg.secret);
    let resp, data;
    try {
      resp = await fetch(SHOPEE_GQL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `SHA256 Credential=${cfg.appId}, Timestamp=${ts}, Signature=${signature}`,
        },
        body: query,
      });
      data = await resp.json();
    } catch (e) {
      return json({ configured: true, items: [], error: "fetch_failed: " + String((e && e.message) || e) });
    }
    if (data && data.errors) return json({ configured: true, items: [], error: (data.errors[0] && data.errors[0].message) || "shopee_error", raw: data.errors });
    const nodes = (((data || {}).data || {}).productOfferV2 || {}).nodes || [];
    const items = nodes.map((n) => ({
      nome: n.productName || "",
      preco: n.priceMin ? ("R$ " + n.priceMin + (n.priceMax && n.priceMax !== n.priceMin ? ("–" + n.priceMax) : "")) : "",
      img: n.imageUrl || "",
      link: n.offerLink || "",
      comissao: n.commissionRate || "",
      rating: n.ratingStar || "",
    }));
    return json({ configured: true, items });
  }

  return json({ error: "unknown_action" }, 400);
}

// ── /api/data — armazenamento no KV (leitura pública; escrita só admin) ──
async function handleData(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const KEY = "site_data";
  if (request.method === "GET") {
    const val = await env.INV_KV.get(KEY);
    return new Response(val || "{}", { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "CDN-Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store", ...CORS } });
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
