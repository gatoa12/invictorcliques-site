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
      if (path === "/api/magalu-resolve") return await handleMagaluResolve(request, url);
      if (path === "/api/refresh-foco") return await handleRefreshFoco(request, env);
      if (path === "/api/tg/webhook")   return await handleTgWebhook(request, env, url);
      if (path === "/api/tg/offers")    return await handleTgOffers(request, env);
      if (path === "/api/tg/offer")     return await handleTgOfferEdit(request, env, url);
      if (path === "/api/tg/reagir")    return await handleTgReagir(request, env, url);
      if (path === "/api/tg/comentarios") return await handleTgComentarios(request, env, url);
      if (path === "/api/tg/img")       return await handleTgImg(request, env, url);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }

    // Qualquer outra coisa = arquivos estáticos do site.
    // 🔄 Pra o site SEMPRE pegar a versão nova (sem ficar "preso" no cache),
    // o HTML é servido com no-cache. Imagens/JS continuam com cache normal.
    //
    // 🆕 LINK "LIMPO" (sem #): tipo invictorcliques.com.br/fotos, /ofertas, /corridacomdesconto...
    // Isso não é um arquivo de verdade — em vez de deixar cair em 404, já sabemos de
    // antemão quais nomes de página são válidos e servimos o próprio site (index.html)
    // direto, sem depender de detectar erro 404 (mais confiável).
    const ROTAS_LIMPAS = new Set([
      "fotos","suasfotos","focoradical","banlek","suasfotosbanlek",
      "ofertas","cupons","cupom","corridacomdesconto","corridacomdescontos",
      "procuratenis","procura","tenis","procure","procureseustenis","tenisofertas","ofertastenis",
      "edicao","edicaoia","copiarestilo","seupreset",
      "minhascorridas","corridas","strava",
      "previewinsta","preview","figurinhas",
      "verificar","verificarfotos","verificarminhasfotos",
      "ofertastelegram","telegram",
      "inicio","admin"
    ]);
    const pathSlug = path.replace(/^\/+|\/+$/g, "").toLowerCase();
    let res;
    if (ROTAS_LIMPAS.has(pathSlug)) {
      res = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    } else {
      res = await env.ASSETS.fetch(request);
      // rede de segurança: se por algum motivo ainda cair em 404 numa rota sem "." no final
      // (arquivo, não link de página), tenta servir o index.html mesmo assim.
      if (res.status === 404 && request.method === "GET" && !/\.[a-zA-Z0-9]+$/.test(path)) {
        const idxRes = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
        if (idxRes.status === 200) res = idxRes;
      }
    }
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
    ctx.waitUntil(cleanupExpiredTgOffers(env).catch(() => {}));
  },
};

// 🧹 apaga de vez, do armazenamento, as ofertas do Telegram com mais de 10h (backup do
// cron — a limpeza principal já acontece sozinha toda vez que alguém abre a página de ofertas).
async function cleanupExpiredTgOffers(env) {
  let list = [];
  try { const raw = await env.INV_KV.get("tg_offers"); if (raw) list = JSON.parse(raw); } catch (e) { return; }
  const TTL = 10 * 60 * 60 * 1000; // 10 horas
  const now = Date.now();
  const vivas = list.filter((o) => (now - (o.ts || 0)) < TTL);
  if (vivas.length !== list.length) {
    try { await env.INV_KV.put("tg_offers", JSON.stringify(vivas)); } catch (e) {}
  }
  // 🧹 também limpa reações e comentários de ofertas que já sumiram, pra não acumular pra sempre
  const idsVivos = new Set(vivas.map((o) => String(o.id)));
  try {
    const raw = await env.INV_KV.get("tg_reactions");
    if (raw) {
      const r = JSON.parse(raw);
      const limpo = {};
      for (const k in r) { if (idsVivos.has(k)) limpo[k] = r[k]; }
      await env.INV_KV.put("tg_reactions", JSON.stringify(limpo));
    }
  } catch (e) {}
  try {
    const raw = await env.INV_KV.get("tg_comments");
    if (raw) {
      const c = JSON.parse(raw);
      const limpo = {};
      for (const k in c) { if (idsVivos.has(k)) limpo[k] = c[k]; }
      await env.INV_KV.put("tg_comments", JSON.stringify(limpo));
    }
  } catch (e) {}
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,x-admin-key",
};

// ── /api/tg/webhook — recebe ofertas postadas no grupo/canal do Telegram ──
async function handleTgWebhook(request, env, url) {
  // segurança: secret via ?s= ou header do Telegram
  const secret = url.searchParams.get("s") || request.headers.get("x-telegram-bot-api-secret-token") || "";
  const expected = env.TG_SECRET || "invcliques-tg-7693";
  if (secret !== expected) return json({ ok: false, error: "unauthorized" }, 401);
  if (request.method !== "POST") return json({ ok: true, note: "webhook ativo" });
  let update;
  try { update = await request.json(); } catch (e) { return json({ ok: true }); }
  const msg = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
  if (!msg) return json({ ok: true });
  const text = (msg.text || msg.caption || "").trim();
  const hasPhoto = !!(msg.photo && msg.photo.length);
  if (!text && !hasPhoto) return json({ ok: true });

  // link (do texto ou das entities)
  let link = "";
  const um = text.match(/https?:\/\/[^\s)]+/);
  if (um) link = um[0];
  const ents = msg.entities || msg.caption_entities || [];
  if (!link) { for (const e of ents) { if (e.type === "text_link" && e.url) { link = e.url; break; } } }

  // é um post de CUPOM? (você sempre começa com "CUPOM" → diferencia das ofertas)
  const primeiraLinha = (text.split("\n").find((l) => l.trim()) || "").trim();
  const isCupom = /\bcupom\b/i.test(primeiraLinha);

  // cupom/código — 📏 REGRA: prioridade é "Cupom: CÓDIGO" (com dois pontos). Se não tiver esse
  // formato, aceita também quando o CÓDIGO já vem em CAIXA ALTA logo perto da palavra "cupom"
  // (ex: "Resgate o cupom DATADUPLA") — isso funciona porque você sempre digita o código de
  // verdade em maiúsculas, enquanto palavras comuns tipo "aqui"/"clique" ficam em minúscula no
  // seu texto — então nunca confunde uma com a outra.
  const ignoraCod = ["CUPOM","AMAZON","SHOPEE","MAGALU","MAGAZINE","OFF","APP","NOAPP","NO","NA","DE","DA","EM","LIMITE","AME","MERCADO","LIVRE","MELI","PIX","NETSHOSE","NETSHOES","CENTAURO","NIKE","ADIDAS","OLYMPIKUS","COM","POR","ATÉ","ATE","DO","PRODUTO","PRODUTOS","OU","AQUI","CLIQUE","LINK","VEJA","CONFIRA","ACESSE","COMPRE","COMPRAR","RESGATE","SEU","SUA","VIA","ANUNCIO","ANÚNCIO"];
  let cupom = "";
  {
    const m = text.match(/cupom\s*:\s*([A-Za-z0-9\-]{3,24})\b/i);
    if (m && m[1] && ignoraCod.indexOf(m[1].toUpperCase()) < 0) cupom = m[1].toUpperCase();
  }
  if (!cupom) {
    const idxCupom = text.search(/cupom/i);
    if (idxCupom >= 0) {
      const after = text.slice(idxCupom, idxCupom + 150);
      // 🔧 código pode começar com número (ex: "7DO7CHEGOUU") — só exige ter PELO MENOS 1 letra
      // maiúscula no meio, pra não confundir com um número puro (preço, ano, etc)
      const cands = after.match(/\b(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,24}\b/g) || [];
      for (const c of cands) { if (ignoraCod.indexOf(c) < 0) { cupom = c; break; } }
    }
  }

  // loja (alternância de lojas): 1ª palavra "conhecida" que aparecer — cobre todos os afiliados
  let loja = "";
  const lojaM = text.match(/\b(amazon|shopee|aliexpress|ali\s?express|shein|kabum|magalu|magazine\s?(?:voc[eê])?|mercado\s?livre|meli|netshoes|centauro|decathlon|nike|adidas|olympikus|fila|asics|mizuno|casas\s?bahia|americanas|submarino|pontofrio|extra|ame)\b/i);
  if (lojaM) loja = lojaM[1].replace(/\s+/g, " ").toUpperCase();

  // preço (ex: "Por: R$159", "R$ 159,90") — se não achar em reais, tenta em dólar (comum em AliExpress)
  let preco = "";
  const pm = text.match(/R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:[.,]\d{2})?)/i);
  if (pm) preco = "R$ " + pm[1];
  if (!preco) {
    const pmUsd = text.match(/US\$\s?(\d+(?:[.,]\d{2})?)|\$\s?(\d+(?:[.,]\d{2})?)/i);
    if (pmUsd) preco = "US$ " + (pmUsd[1] || pmUsd[2]);
  }

  // imagem: guarda o file_id (a imagem é servida pelo proxy /api/tg/img, sem expor o token)
  let imgId = "";
  if (hasPhoto) { imgId = msg.photo[msg.photo.length - 1].file_id || ""; }

  // título limpo = a linha com 🔥 (você sempre marca o produto com fogo); senão 1ª linha real
  // 🔧 mas pula linha de preço/cupom mesmo que tenha 🔥 (ex: "🔥 Por: R$260,99 Via pix" NÃO é o nome do produto)
  let title = "";
  const linhas = text.split("\n").map((s) => s.trim()).filter(Boolean);
  const _ehLinhaDeInfo = (c) => /^(por|cupom|c[oó]digo|compre|compre aqui|assine|encontre|link|p[aá]gina|via\s*pix)/i.test(c);
  for (const ln of linhas) {
    if (!/🔥/.test(ln)) continue;
    const c = ln.replace(/🔥/g, "").replace(/^[^0-9A-Za-zÀ-ÿ]+/, "").trim();
    if (_ehLinhaDeInfo(c) || c.length < 4) continue;
    title = c.slice(0, 120); break;
  }
  if (!title) {
    for (const ln of linhas) {
      if (/^#/.test(ln)) continue;
      if (/^https?:\/\//i.test(ln)) continue;
      const c = ln.replace(/^[^0-9A-Za-zÀ-ÿ]+/, "").trim();
      if (_ehLinhaDeInfo(c)) continue;
      if (c.length < 4) continue;
      title = c.slice(0, 120); break;
    }
  }
  if (!title) title = (linhas[0] || "Oferta").slice(0, 120);

  // 👉 canal/usuário de origem do post (pra montar o link "Ver no Telegram" certinho, direto pro post)
  const chatUsername = (msg.chat && msg.chat.username) || "";

  const offer = { id: msg.message_id || Date.now(), title, text: text.slice(0, 700), link, cupom, preco, loja, isCupom, imgId, chatUsername, ts: Date.now() };

  let list = [];
  try { const raw = await env.INV_KV.get("tg_offers"); if (raw) list = JSON.parse(raw); } catch (e) {}
  list = list.filter((o) => o.id !== offer.id);
  list.unshift(offer);
  if (list.length > 40) list = list.slice(0, 40);
  try { await env.INV_KV.put("tg_offers", JSON.stringify(list)); } catch (e) {}
  return json({ ok: true });
}

// ── /api/tg/offers — devolve as ofertas guardadas do Telegram ──
async function handleTgOffers(request, env) {
  let list = [];
  try { const raw = await env.INV_KV.get("tg_offers"); if (raw) list = JSON.parse(raw); } catch (e) {}
  const TTL = 10 * 60 * 60 * 1000; // 10 horas
  const now = Date.now();
  // remove as expiradas (mais de 10h)
  const vivas = list.filter((o) => (now - (o.ts || 0)) < TTL);
  // se limpou alguma, regrava a lista enxuta
  if (vivas.length !== list.length) { try { await env.INV_KV.put("tg_offers", JSON.stringify(vivas)); } catch (e) {} }
  // 🔥 reações (contador de "gostei" por oferta)
  let reacoes = {};
  try { const raw2 = await env.INV_KV.get("tg_reactions"); if (raw2) reacoes = JSON.parse(raw2); } catch (e) {}
  const out = vivas.map((o) => ({
    id: o.id, title: o.title, text: o.text, link: o.link || "", cupom: o.cupom || "", preco: o.preco || "",
    loja: o.loja || "", isCupom: !!o.isCupom, chatUsername: o.chatUsername || "",
    img: o.imgId ? ("/api/tg/img?id=" + encodeURIComponent(o.imgId)) : "",
    reacoes: (reacoes[String(o.id)] && typeof reacoes[String(o.id)]==='object') ? reacoes[String(o.id)] : { quente: 0, frio: 0 },
    ts: o.ts, expires: (o.ts || now) + TTL
  }));
  return json({ offers: out });
}

// ── /api/tg/reagir — qualquer visitante pode reagir (🔥 quente / ❄️ frio) numa oferta; não precisa de senha ──
async function handleTgReagir(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const id = url.searchParams.get("id") || "";
  const tipo = url.searchParams.get("tipo") === "frio" ? "frio" : "quente";
  if (!id) return json({ error: "id obrigatório" }, 400);
  let reacoes = {};
  try { const raw = await env.INV_KV.get("tg_reactions"); if (raw) reacoes = JSON.parse(raw); } catch (e) {}
  if (!reacoes[id] || typeof reacoes[id] !== "object") reacoes[id] = { quente: 0, frio: 0 };
  reacoes[id][tipo] = (reacoes[id][tipo] || 0) + 1;
  try { await env.INV_KV.put("tg_reactions", JSON.stringify(reacoes)); } catch (e) {}
  return json({ ok: true, reacoes: reacoes[id][tipo] });
}

// ── /api/tg/comentarios — ver (GET) ou postar (POST) comentários numa oferta; qualquer visitante pode comentar ──
async function handleTgComentarios(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const id = url.searchParams.get("id") || "";
  if (!id) return json({ error: "id obrigatório" }, 400);
  let all = {};
  try { const raw = await env.INV_KV.get("tg_comments"); if (raw) all = JSON.parse(raw); } catch (e) {}

  if (request.method === "GET") {
    return json({ comentarios: all[id] || [] });
  }
  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "json inválido" }, 400); }
    const nome = String(body.nome || "").trim().slice(0, 40) || "Corredor anônimo";
    const texto = String(body.texto || "").trim().slice(0, 300);
    if (!texto) return json({ error: "comentário vazio" }, 400);
    if (!all[id]) all[id] = [];
    all[id].push({ nome, texto, ts: Date.now() });
    if (all[id].length > 60) all[id] = all[id].slice(-60); // limite por oferta, pra não crescer sem fim
    try { await env.INV_KV.put("tg_comments", JSON.stringify(all)); } catch (e) {}
    return json({ ok: true, total: all[id].length });
  }
  return json({ error: "method_not_allowed" }, 405);
}

// ── /api/tg/offer — editar (PUT) ou apagar (DELETE) UMA oferta do Telegram, direto do painel admin ──
async function handleTgOfferEdit(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const provided = request.headers.get("x-admin-key") || "";
  if (!env.ADMIN_WRITE_KEY || provided !== env.ADMIN_WRITE_KEY) return json({ error: "unauthorized" }, 403);
  const id = url.searchParams.get("id") || "";
  if (!id) return json({ error: "id obrigatório" }, 400);

  let list = [];
  try { const raw = await env.INV_KV.get("tg_offers"); if (raw) list = JSON.parse(raw); } catch (e) {}

  if (request.method === "DELETE") {
    const before = list.length;
    list = list.filter((o) => String(o.id) !== String(id));
    try { await env.INV_KV.put("tg_offers", JSON.stringify(list)); } catch (e) {}
    return json({ ok: true, deleted: before !== list.length });
  }

  if (request.method === "PUT" || request.method === "POST") {
    let patch;
    try { patch = await request.json(); } catch (e) { return json({ error: "json inválido" }, 400); }
    const idx = list.findIndex((o) => String(o.id) === String(id));
    if (idx === -1) return json({ error: "oferta não encontrada" }, 404);
    const allow = ["title", "text", "link", "cupom", "preco", "loja", "chatUsername"];
    allow.forEach((k) => { if (patch[k] !== undefined) list[idx][k] = patch[k]; });
    try { await env.INV_KV.put("tg_offers", JSON.stringify(list)); } catch (e) {}
    return json({ ok: true, offer: list[idx] });
  }

  return json({ error: "method_not_allowed" }, 405);
}

// ── /api/tg/img — proxy seguro da imagem (não expõe o token do bot) ──
async function handleTgImg(request, env, url) {
  const id = url.searchParams.get("id") || "";
  const token = env.TG_BOT_TOKEN || "";
  if (!id || !token) return new Response("", { status: 404 });
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/getFile?file_id=" + encodeURIComponent(id));
    const d = await r.json();
    if (!d.ok || !d.result || !d.result.file_path) return new Response("", { status: 404 });
    const img = await fetch("https://api.telegram.org/file/bot" + token + "/" + d.result.file_path);
    const h = new Headers();
    h.set("content-type", img.headers.get("content-type") || "image/jpeg");
    h.set("cache-control", "public, max-age=86400");
    return new Response(img.body, { status: 200, headers: h });
  } catch (e) { return new Response("", { status: 404 }); }
}

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

// ── /api/magalu-resolve — abre o link encurtado do divulgador e pega promoter_id/partner_id ──
async function handleMagaluResolve(request, url) {
  try {
    const u = url.searchParams.get("u") || "";
    if (!u || !/^https?:\/\//i.test(u)) return json({ error: "link inválido" }, 400);
    let promoter = "", partner = "", finalUrl = "";
    try {
      const r = await fetch(u, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; InvBot/1.0)" } });
      finalUrl = r.url || "";
      let m1 = finalUrl.match(/promoter_id=([^&\s]+)/i); if (m1) promoter = m1[1];
      let m2 = finalUrl.match(/partner_id=([^&\s]+)/i); if (m2) partner = m2[1];
      if (!promoter || !partner) {
        let txt = "";
        try { txt = await r.text(); } catch (e) {}
        if (!promoter) { const a = txt.match(/promoter_id["'=:\s]*?(\d{3,})/i); if (a) promoter = a[1]; }
        if (!partner)  { const b = txt.match(/partner_id["'=:\s]*?(\d{2,})/i);  if (b) partner = b[1]; }
        // procura também a URL completa dentro do HTML (meta refresh / canonical)
        if (!promoter || !partner) {
          const fm = txt.match(/magazineluiza\.com\.br[^"'\s]*promoter_id=\d+[^"'\s]*/i);
          if (fm) { const f = fm[0]; const p = f.match(/promoter_id=([^&\s"']+)/i); const q = f.match(/partner_id=([^&\s"']+)/i); if (p && !promoter) promoter = p[1]; if (q && !partner) partner = q[1]; if (!finalUrl) finalUrl = "https://www." + f; }
        }
      }
    } catch (e) {
      return json({ error: "não consegui abrir o link: " + String((e && e.message) || e) }, 200);
    }
    return json({ promoter, partner, finalUrl, ok: !!(promoter && partner) }, 200);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 200);
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
