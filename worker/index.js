/**
 * Cloudflare Worker — PromoScan
 * type: 'chat' → domande sulle promo con Gemini → restituisce {answer}
 *
 * Secrets: GEMINI_API_KEY
 * Vars (wrangler.toml): GITHUB_REPO
 */

const GEMINI_URL = (key, model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const MODEL_CHAT = 'gemini-2.5-flash';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(null, 204);
    if (request.method !== 'POST') return cors(JSON.stringify({ error: 'Method not allowed' }), 405);

    let body;
    try { body = await request.json(); }
    catch { return cors(JSON.stringify({ error: 'Invalid JSON' }), 400); }

    const apiKey = env.GEMINI_API_KEY || '';
    if (!apiKey) return cors(JSON.stringify({ error: 'GEMINI_API_KEY non configurata' }), 500);

    /* ── CHAT ── */
    const { sku, promos = [], promoIds = [], question } = body;
    if (!question) return cors(JSON.stringify({ error: 'Missing question' }), 400);

    const repo = env.GITHUB_REPO || '';

    const tcDocs = [];
    for (const pid of promoIds.slice(0, 5)) {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${repo}/main/promos/${pid}/tc.txt`);
        if (r.ok) tcDocs.push(`--- T&C Promo ${pid} ---\n${(await r.text()).slice(0, 8000)}`);
      } catch { /* non caricato */ }
    }

    let regDoc = '';
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${repo}/main/data/registration.txt`);
      if (r.ok) regDoc = await r.text();
    } catch { /* non caricato */ }

    const systemPrompt = `Sei un assistente per il team di field marketing e i commessi dei punti vendita.
Prodotto: ${sku || 'non specificato'}
${promos.length > 0 ? `Promozioni attive:\n${JSON.stringify(promos, null, 2)}` : 'Nessuna promo attiva.'}
${tcDocs.length > 0 ? `\nT&C:\n${tcDocs.join('\n\n')}` : '\nT&C non ancora caricati.'}
${regDoc ? `\nGuida registrazione:\n${regDoc.slice(0, 4000)}` : ''}

Rispondi SEMPRE in italiano, in modo chiaro e conciso (max 3-4 frasi).
Non inventare dettagli non presenti nei dati. Per casi non coperti, suggerisci di contattare il referente aziendale.`;

    try {
      const resp = await fetch(GEMINI_URL(apiKey, MODEL_CHAT), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: question.slice(0, 500) }] }],
          generationConfig: { maxOutputTokens: 512, temperature: 0.3 },
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        return cors(JSON.stringify({ answer: `Errore Gemini (${resp.status}): ${err.slice(0, 200)}` }), 200);
      }

      const data = await resp.json();
      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Nessuna risposta disponibile.';
      return cors(JSON.stringify({ answer }), 200);
    } catch (e) {
      return cors(JSON.stringify({ answer: `Errore: ${e.message}` }), 200);
    }
  },
};

function cors(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
