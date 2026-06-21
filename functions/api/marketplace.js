// Cloudflare Pages Function — /api/marketplace
// Busca de produtos (Mercado Livre público; Shopee com chaves).
// Variáveis opcionais (Settings → Variables and Secrets):
//   SHOPEE_APP_ID, SHOPEE_SECRET  (só se for usar Shopee)
//   ML_AFFILIATE                  (opcional, tag de afiliado no Mercado Livre)

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...CORS } });
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").trim();
  const source = (u.searchParams.get("source") || "mercadolivre").trim();
  const limit = Math.min(parseInt(u.searchParams.get("limit") || "6", 10) || 6, 20);
  if (!q) return json({ results: [], error: "Falta o parâmetro q." }, 400);
  try {
    let results = [];
    if (source === "mercadolivre") results = await searchML(q, limit, env);
    else if (source === "shopee") results = await searchShopee(q, limit, env);
    else return json({ results: [], error: "source inválido: " + source }, 400);
    return json({ source, results });
  } catch (e) {
    return json({ source, results: [], error: String((e && e.message) || e) });
  }
}

async function searchML(q, limit, env) {
  const url = "https://api.mercadolibre.com/sites/MLB/search?q=" + encodeURIComponent(q) + "&limit=" + limit;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Mercado Livre " + r.status);
  const j = await r.json();
  const aff = env.ML_AFFILIATE || "";
  return (j.results || []).map((it) => ({
    title: it.title,
    price: it.price,
    img: String(it.thumbnail || "").replace(/^http:/, "https:").replace("-I.jpg", "-O.jpg"),
    link: aff ? addParam(it.permalink, "matt_word", aff) : it.permalink,
    source: "Mercado Livre",
  }));
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function searchShopee(q, limit, env) {
  const appId = env.SHOPEE_APP_ID || "";
  const secret = env.SHOPEE_SECRET || "";
  if (!appId || !secret) throw new Error("Shopee não configurada: defina SHOPEE_APP_ID e SHOPEE_SECRET.");
  const endpoint = "https://open-api.affiliate.shopee.com.br/graphql";
  const query = `{ productOfferV2(keyword: "${q.replace(/"/g, '\\"')}", limit: ${limit}, page: 1) { nodes { productName price imageUrl offerLink } } }`;
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const sign = await sha256Hex(appId + ts + payload + secret);
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${sign}` },
    body: payload,
  });
  if (!r.ok) throw new Error("Shopee " + r.status);
  const j = await r.json();
  const nodes = (((j.data || {}).productOfferV2 || {}).nodes) || [];
  return nodes.map((n) => ({ title: n.productName, price: Number(n.price), img: n.imageUrl, link: n.offerLink, source: "Shopee" }));
}

function addParam(url, k, v) {
  try { const u = new URL(url); u.searchParams.set(k, v); return u.toString(); } catch (e) { return url; }
}
