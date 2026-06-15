// ============================================================================
//  PROXY DE MARKETPLACES — função serverless da Vercel
//  Caminho no projeto: /api/marketplace.js  → fica disponível em /api/marketplace
//
//  Pra que serve: guarda as CHAVES SECRETAS no servidor (nunca no navegador) e
//  faz as buscas que precisam de autenticação (Shopee etc.) sem expor nada.
//
//  ⚠️ As chaves NÃO ficam no código. Configure como variáveis de ambiente na
//     Vercel (Settings → Environment Variables) e dê Redeploy:
//       SHOPEE_APP_ID, SHOPEE_SECRET
//       ML_AFFILIATE   (opcional, pra tag de afiliado no link do Mercado Livre)
// ============================================================================

const crypto = require('node:crypto');

module.exports = async function handler(req, res) {
  // CORS — libera seu site a chamar essa função
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = String((req.query && req.query.q) || '').trim();
  const source = String((req.query && req.query.source) || 'mercadolivre').trim();
  const limit = Math.min(parseInt((req.query && req.query.limit) || '6', 10) || 6, 20);

  if (!q) return res.status(400).json({ results: [], error: 'Falta o parâmetro q (o que buscar).' });

  try {
    let results = [];
    if (source === 'mercadolivre') results = await searchML(q, limit);
    else if (source === 'shopee')   results = await searchShopee(q, limit);
    else if (source === 'magalu')   results = await searchMagalu(q, limit);
    else if (source === 'netshoes') results = await searchNetshoes(q, limit);
    else return res.status(400).json({ results: [], error: 'source inválido: ' + source });

    return res.status(200).json({ source, results });
  } catch (e) {
    // Nunca derruba o site — devolve lista vazia + motivo
    return res.status(200).json({ source, results: [], error: String((e && e.message) || e) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MERCADO LIVRE — API pública (funciona sem chave). Aqui no servidor dá pra
//  juntar a tag de afiliado no link, se você tiver (ML_AFFILIATE).
// ─────────────────────────────────────────────────────────────────────────────
async function searchML(q, limit) {
  const url = 'https://api.mercadolibre.com/sites/MLB/search?q=' + encodeURIComponent(q) + '&limit=' + limit;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Mercado Livre ' + r.status);
  const j = await r.json();
  const aff = process.env.ML_AFFILIATE || '';
  return (j.results || []).map((it) => ({
    title: it.title,
    price: it.price,
    img: String(it.thumbnail || '').replace(/^http:/, 'https:').replace('-I.jpg', '-O.jpg'),
    link: aff ? addParam(it.permalink, 'matt_word', aff) : it.permalink,
    source: 'Mercado Livre',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  SHOPEE — Affiliate Open API (Brasil). Usa assinatura SHA256.
//  Precisa de conta no Programa de Afiliados Shopee + SHOPEE_APP_ID / SHOPEE_SECRET.
//  Doc: https://open-api.affiliate.shopee.com.br  (GraphQL: productOfferV2)
// ─────────────────────────────────────────────────────────────────────────────
async function searchShopee(q, limit) {
  const appId = process.env.SHOPEE_APP_ID || '';
  const secret = process.env.SHOPEE_SECRET || '';
  if (!appId || !secret) {
    throw new Error('Shopee não configurada: defina SHOPEE_APP_ID e SHOPEE_SECRET nas variáveis de ambiente da Vercel.');
  }
  const endpoint = 'https://open-api.affiliate.shopee.com.br/graphql';
  const query = `{ productOfferV2(keyword: "${q.replace(/"/g, '\\"')}", limit: ${limit}, page: 1) {
    nodes { productName price imageUrl offerLink } } }`;
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  // Assinatura: SHA256(appId + timestamp + payload + secret)
  const sign = crypto.createHash('sha256').update(appId + ts + payload + secret).digest('hex');

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${sign}`,
    },
    body: payload,
  });
  if (!r.ok) throw new Error('Shopee ' + r.status);
  const j = await r.json();
  const nodes = (((j.data || {}).productOfferV2 || {}).nodes) || [];
  return nodes.map((n) => ({
    title: n.productName,
    price: Number(n.price),
    img: n.imageUrl,
    link: n.offerLink,
    source: 'Shopee',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAGALU — geralmente via rede de afiliados (Awin/Lomadee), não há busca pública
//  direta por palavra-chave. Quando você tiver as credenciais da rede, ligo aqui.
// ─────────────────────────────────────────────────────────────────────────────
async function searchMagalu(q, limit) {
  const key = process.env.MAGALU_API_KEY || '';
  if (!key) throw new Error('Magalu precisa de credencial de afiliado (Awin/Lomadee/Parceiro Magalu). Me passe que eu ligo aqui.');
  // TODO: implementar com o endpoint da rede de afiliados que você usar.
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
//  NETSHOES — idem: afiliação via rede (Awin/Lomadee). Sem API pública de busca.
// ─────────────────────────────────────────────────────────────────────────────
async function searchNetshoes(q, limit) {
  const key = process.env.NETSHOES_API_KEY || '';
  if (!key) throw new Error('Netshoes precisa de credencial de afiliado (Awin/Lomadee). Me passe que eu ligo aqui.');
  // TODO: implementar com o endpoint da rede de afiliados que você usar.
  return [];
}

// util: adiciona um parâmetro na URL
function addParam(url, k, v) {
  try {
    const u = new URL(url);
    u.searchParams.set(k, v);
    return u.toString();
  } catch (e) {
    return url;
  }
}
