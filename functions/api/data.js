// Cloudflare Pages Function — /api/data
// GET  -> devolve os dados do site (KV).  Aberto (visitantes leem).
// POST -> grava os dados do site (KV).  Protegido: só com a chave de admin.
//
// Pré-requisitos no painel do Cloudflare (Pages -> Settings):
//   1) KV namespace binding com o nome:  INV_KV
//   2) Environment variable (secret) com o nome:  ADMIN_WRITE_KEY
//
// Rota final: https://SEU-SITE/api/data

const KEY = "site_data"; // uma única "gaveta" no KV com o JSON do site

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-admin-key",
};

export async function onRequestGet(context) {
  try {
    const val = await context.env.INV_KV.get(KEY);
    return new Response(val || "{}", {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "read_failed" }), {
      status: 500,
      headers: { "content-type": "application/json", ...CORS },
    });
  }
}

export async function onRequestPost(context) {
  const provided = context.request.headers.get("x-admin-key") || "";
  // Só grava se a chave bater com o segredo do servidor
  if (!context.env.ADMIN_WRITE_KEY || provided !== context.env.ADMIN_WRITE_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 403,
      headers: { "content-type": "application/json", ...CORS },
    });
  }
  try {
    const body = await context.request.text();
    JSON.parse(body); // valida que é JSON de verdade
    await context.env.INV_KV.put(KEY, body);
    return new Response(JSON.stringify({ ok: true, savedAt: Date.now() }), {
      headers: { "content-type": "application/json", ...CORS },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "content-type": "application/json", ...CORS },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}
