/**
 * Cloudflare Worker — PromoScan AI proxy (ES Module format)
 *
 * Variabili d'ambiente da impostare nel dashboard Cloudflare:
 *   GEMINI_API_KEY  → chiave API Google Gemini (gratuita su aistudio.google.com)
 *   GITHUB_REPO     → es. "aceKuno/promoscan"
 */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    if (request.method !== 'POST') {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return corsResponse(JSON.stringify({ error: 'Invalid JSON' }), 400);
    }

    const { sku, promos = [], promoIds = [], question } = body;

    if (!question || typeof question !== 'string') {
      return corsResponse(JSON.stringify({ error: 'Missing question' }), 400);
    }

    const sanitizedQuestion = question.slice(0, 500);
    const apiKey = env.GEMINI_API_KEY || '';
    const repo   = env.GITHUB_REPO   || '';

    if (!apiKey) {
      return corsResponse(JSON.stringify({
        answer: 'Configurazione mancante: GEMINI_API_KEY non impostata nel Worker.'
      }), 200);
    }

    // Fetch T&C per ogni promo attiva
    const tcDocs = [];
    for (const promoId of promoIds.slice(0, 5)) {
      try {
        const url = `https://raw.githubusercontent.com/${repo}/main/promos/${promoId}/tc.txt`;
        const resp = await fetch(url);
        if (resp.ok) {
          const text = await resp.text();
          tcDocs.push(`--- T&C Promozione ${promoId} ---\n${text.slice(0, 8000)}`);
        }
      } catch { /* documento non ancora caricato */ }
    }

    // Fetch documento registrazione generale
    let regDoc = '';
    try {
      const regResp = await fetch(
        `https://raw.githubusercontent.com/${repo}/main/data/registration.txt`
      );
      if (regResp.ok) regDoc = await regResp.text();
    } catch { /* non ancora caricato */ }

    const promoContext = promos.length > 0
      ? `Promozioni attive per questo prodotto:\n${JSON.stringify(promos, null, 2)}`
      : `Non ci sono promozioni attive per il prodotto ${sku}.`;

    const tcContext = tcDocs.length > 0
      ? `\nDocumenti T&C:\n${tcDocs.join('\n\n')}`
      : '\nI documenti T&C non sono ancora stati caricati.';

    const regContext = regDoc
      ? `\nGuida alla registrazione:\n${regDoc.slice(0, 4000)}`
      : '';

    const systemPrompt = `Sei un assistente specializzato in promozioni per il team di field marketing e i commessi dei punti vendita.

Prodotto scansionato: ${sku || 'non specificato'}

${promoContext}${tcContext}${regContext}

ISTRUZIONI:
- Rispondi SEMPRE in italiano, in modo chiaro e diretto
- Sii conciso: massimo 3-4 frasi per risposta
- Usa i dati forniti sopra per rispondere; non inventare dettagli su premi o requisiti
- Per situazioni non coperte, suggerisci di contattare il referente aziendale`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    try {
      const geminiResp = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: sanitizedQuestion }] }],
          generationConfig: { maxOutputTokens: 512, temperature: 0.3 },
        }),
      });

      if (!geminiResp.ok) {
        const errText = await geminiResp.text();
        console.error('Gemini error:', errText);
        return corsResponse(JSON.stringify({
          answer: `Errore Gemini (${geminiResp.status}): ${errText.slice(0, 300)}`
        }), 200);
      }

      const data = await geminiResp.json();
      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text
        || 'Nessuna risposta disponibile.';
      return corsResponse(JSON.stringify({ answer }), 200);

    } catch (e) {
      console.error('Worker fetch error:', e);
      return corsResponse(JSON.stringify({
        answer: `Errore connessione AI: ${e.message}`
      }), 200);
    }
  },
};

function corsResponse(body, status) {
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
