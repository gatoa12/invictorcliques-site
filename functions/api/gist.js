// Cloudflare Pages Function — /api/gist
// Leitura (GET) pública; escrita (POST) usa o token guardado no servidor.
// Variável (Settings → Variables and Secrets):  GIST_TOKEN  (token do GitHub, scope: gist)
// Obs: será aposentado depois que o site migrar pro KV (/api/data).

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...CORS } });
}

const GH = {
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "invictorcliques-sync",
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet(context) {
  const u = new URL(context.request.url);
  const id = (u.searchParams.get("id") || "").trim();
  if (!id) return json({ error: "Falta o id do gist." }, 400);
  try {
    const r = await fetch("https://api.github.com/gists/" + id, { headers: GH });
    const text = await r.text();
    return new Response(text, { status: r.ok ? 200 : r.status, headers: { "content-type": "application/json", ...CORS } });
  } catch (e) {
    return json({ error: String((e && e.message) || e) });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const u = new URL(request.url);
  const id = (u.searchParams.get("id") || "").trim();
  if (!id) return json({ error: "Falta o id do gist." }, 400);
  const TOKEN = env.GIST_TOKEN || "";
  if (!TOKEN) return json({ error: "GIST_TOKEN não configurado." }, 500);
  try {
    let body = await request.text();
    try { body = JSON.parse(body); } catch (e) { body = {}; }
    if (!body || !body.files) return json({ error: "Falta o campo files no corpo." }, 400);
    const r = await fetch("https://api.github.com/gists/" + id, {
      method: "PATCH",
      headers: { ...GH, "Authorization": "token " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ files: body.files }),
    });
    const j = await r.json();
    return json({ ok: r.ok, id: j.id || id }, r.ok ? 200 : r.status);
  } catch (e) {
    return json({ error: String((e && e.message) || e) });
  }
}
