// ============================================================================
//  PROXY DO GIST — função serverless da Vercel
//  Caminho no projeto: /api/gist.js  → fica disponível em /api/gist
//
//  Guarda o TOKEN do GitHub no servidor (nunca no navegador) e faz a
//  publicação (escrita) no Gist de forma segura.
//
//  ⚠️ Configure na Vercel (Settings → Environment Variables) e dê Redeploy:
//       GIST_TOKEN = seu novo token do GitHub (scope: gist)
//
//  Leitura (GET) é pública e não precisa de token. Escrita (POST) usa o token.
// ============================================================================

const TOKEN = process.env.GIST_TOKEN || '';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const id = String((req.query && req.query.id) || '').trim();
  if (!id) return res.status(400).json({ error: 'Falta o id do gist.' });

  const ghHeaders = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'invictorcliques-sync',
  };

  try {
    if (req.method === 'GET') {
      // leitura pública (não precisa de token)
      const r = await fetch('https://api.github.com/gists/' + id, { headers: ghHeaders });
      const j = await r.json();
      return res.status(r.ok ? 200 : r.status).json(j);
    }

    // POST = escrita (publicar) — precisa do token
    if (!TOKEN) {
      return res.status(500).json({ error: 'GIST_TOKEN não configurado nas variáveis de ambiente da Vercel.' });
    }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    if (!body || !body.files) return res.status(400).json({ error: 'Falta o campo files no corpo.' });

    const r = await fetch('https://api.github.com/gists/' + id, {
      method: 'PATCH',
      headers: Object.assign({}, ghHeaders, {
        'Authorization': 'token ' + TOKEN,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ files: body.files }),
    });
    const j = await r.json();
    return res.status(r.ok ? 200 : r.status).json({ ok: r.ok, id: j.id || id });
  } catch (e) {
    return res.status(200).json({ error: String((e && e.message) || e) });
  }
};
