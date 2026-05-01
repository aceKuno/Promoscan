/**
 * Cloudflare Worker — PromoScan
 * type: 'chat' → domande sulle promo con Gemini → restituisce {answer}
 *
 * Secrets: GEMINI_API_KEY
 * Vars (wrangler.toml): GITHUB_REPO
 */

const GEMINI_URL = (key, model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const MODEL_OCR  = 'gemini-flash-latest';
const MODEL_CHAT = 'gemini-flash-latest';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(null, 204);
    if (request.method !== 'POST') return cors(JSON.stringify({ error: 'Method not allowed' }), 405);

    let body;
    try { body = await request.json(); }
    catch { return cors(JSON.stringify({ error: 'Invalid JSON' }), 400); }

    const apiKey = env.GEMINI_API_KEY || '';
    if (!apiKey) return cors(JSON.stringify({ error: 'GEMINI_API_KEY non configurata' }), 500);

    /* ── OCR ── */
    if (body.type === 'ocr') {
      const { image } = body;
      if (!image) return cors(JSON.stringify({ sku: null, confidence: 0 }), 200);

      const prompt = `Stai guardando la foto di un cartellino o di un'etichetta di un elettrodomestico (lavatrice, frigorifero, forno, asciugatrice, lavastoviglie, microonde, aspirapolvere, piano cottura, condizionatore, TV, ecc.).

Il tuo compito: leggere TUTTI i codici alfanumerici visibili nell'immagine che potrebbero essere un codice modello di prodotto.

Un codice modello tipicamente ha queste caratteristiche:
- 8-18 caratteri
- Solo lettere maiuscole e cifre (a volte una "/" prima degli ultimi 2-3 caratteri)
- Esempi: RB38C607AS9/EF, WW11DB8B95GBU3, RT38CG6624S9ES, NV7B4440VBB/U5, DV90F09F4SU3, QE55Q70CATXZT, VS70H25WFT/WA

Elenca TUTTI i candidati che vedi (anche se non sei sicuro al 100%), uno per riga, in ordine di prominenza visiva (il più grande/evidente per primo). Includi tutto ciò che ASSOMIGLIA a un codice modello, anche se incerto.

NON includere: prezzi, EAN a 13 cifre, classi energetiche (es. A+++), watt, capacità (es. 8KG, 38L).

Rispondi SOLO con questo JSON (niente markdown, niente backtick):
{"candidates":["CODICE1","CODICE2","CODICE3"]}

Se proprio non vedi nulla che assomigli a un codice: {"candidates":[]}`;

      try {
        const fetchPromise = fetch(GEMINI_URL(apiKey, MODEL_OCR), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: image } },
            ]}],
            generationConfig: { maxOutputTokens: 200, temperature: 0 },
          }),
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 12000)
        );
        const resp = await Promise.race([fetchPromise, timeoutPromise]);

        if (!resp.ok) {
          const errText = await resp.text();
          return cors(JSON.stringify({ sku: null, confidence: 0, error: `${resp.status}: ${errText.slice(0,150)}` }), 200);
        }
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return cors(JSON.stringify({ sku: null, confidence: 0, _raw: text.slice(0, 200) }), 200);
        let parsed;
        try { parsed = JSON.parse(match[0]); }
        catch { return cors(JSON.stringify({ sku: null, confidence: 0, _raw: text.slice(0, 200) }), 200); }
        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : (parsed.sku ? [parsed.sku] : []);
        return cors(JSON.stringify({ candidates, _raw: text.slice(0, 200) }), 200);
      } catch (e) {
        return cors(JSON.stringify({ sku: null, confidence: 0, error: e.message }), 200);
      }
    }

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
