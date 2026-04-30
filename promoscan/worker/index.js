/**
 * Cloudflare Worker — PromoScan AI proxy
 *
 * Variabili d'ambiente da impostare nel dashboard Cloudflare:
 *   ANTHROPIC_API_KEY  → la tua chiave API Anthropic
 *   GITHUB_REPO        → es. "tuonome/promoscan"
 */

const ALLOWED_ORIGINS = ['*']; // Restringi al tuo dominio github.io in produzione

export default {
  async fetch(request, env) {
    // CORS preflight
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

    // Validazione input
    if (!question || typeof question !== 'string') {
      return corsResponse(JSON.stringify({ error: 'Missing question' }), 400);
    }

    const sanitizedQuestion = question.slice(0, 500);
    const repo = env.GITHUB_REPO || '';

    // Fetch T&C per ogni promo attiva
    const tcDocs = [];
    for (const promoId of promoIds.slice(0, 5)) {
      try {
        const url = `https://raw.githubusercontent.com/${repo}/main/promos/${promoId}/tc.txt`;
        const resp = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 3600 } });
        if (resp.ok) {
          const text = await resp.text();
          tcDocs.push(`--- T&C Promozione ${promoId} ---\n${text.slice(0, 8000)}`);
        }
      } catch { /* documento non ancora caricato */ }
    }

    // Fetch documento registrazione generale
    let regDoc = '';
    try {
      const regUrl = `https://raw.githubusercontent.com/${repo}/main/data/registration.txt`;
      const regResp = await fetch(regUrl, { cf: { cacheEverything: true, cacheTtl: 3600 } });
      if (regResp.ok) {
        regDoc = await regResp.text();
      }
    } catch { /* documento non ancora caricato */ }

    // Costruzione contesto per Claude
    const promoContext = promos.length > 0
      ? `Promozioni attive per questo prodotto:\n${JSON.stringify(promos, null, 2)}`
      : `Non ci sono promozioni attive per il prodotto ${sku}.`;

    const tcContext = tcDocs.length > 0
      ? `\nDocumenti Termini e Condizioni:\n${tcDocs.join('\n\n')}`
      : '\nI documenti T&C non sono ancora stati caricati per queste promozioni.';

    const regContext = regDoc
      ? `\nGuida alla registrazione:\n${regDoc.slice(0, 4000)}`
      : '';

    const systemPrompt = `Sei un assistente specializzato in promozioni per il team di field marketing e i commessi dei punti vendita.

Prodotto scansionato: ${sku || 'non specificato'}

${promoContext}${tcContext}${regContext}

ISTRUZIONI:
- Rispondi SEMPRE in italiano, in modo chiaro e diretto
- Sii conciso: massimo 3-4 frasi per risposta
- Se ti chiedono di una promozione specifica, usa i dati forniti sopra
- Se ti chiedono come registrarsi, spiega il processo usando la guida alla registrazione
- Se non hai informazioni sufficienti, dillo chiaramente senza inventare
- Non inventare dettagli su premi o requisiti non presenti nei dati
- Per situazioni particolari con clienti, suggerisci sempre di contattare il referente aziendale se il caso non è coperto dalle istruzioni disponibili`;

    // Chiamata Claude API
    try {
      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 512,
          system: systemPrompt,
          messages: [{ role: 'user', content: sanitizedQuestion }],
        }),
      });

      if (!claudeResp.ok) {
        const err = await claudeResp.text();
        console.error('Claude API error:', err);
        return corsResponse(JSON.stringify({
          answer: 'Si è verificato un errore nel servizio AI. Riprova tra qualche istante.'
        }), 200);
      }

      const claudeData = await claudeResp.json();
      const answer = claudeData.content?.[0]?.text || 'Nessuna risposta disponibile.';

      return corsResponse(JSON.stringify({ answer }), 200);
    } catch (e) {
      console.error('Worker error:', e);
      return corsResponse(JSON.stringify({
        answer: 'Errore di connessione al servizio AI.'
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
