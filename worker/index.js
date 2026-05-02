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

      const prompt = `Sei un sistema OCR specializzato. Analizza l'immagine e leggi TUTTI i codici modello di prodotto visibili.

L'immagine può essere: cartellino prezzo in negozio, etichetta tecnica, scatola del prodotto, schermo con pagina web (Samsung.com, Amazon, MediaWorld, ecc.), manuale d'uso, schermo del prodotto stesso.

Un CODICE MODELLO ha queste caratteristiche:
- 9-18 caratteri totali
- Solo lettere maiuscole A-Z e cifre 0-9
- Mix di lettere e cifre (NON è solo numeri, NON è solo lettere)
- A volte contiene una "/" prima di un suffisso di 2-4 caratteri (es: /EF, /U5, /WA, /TXZT)
- Esempi reali: RB38C607AS9/EF, WW11DB8B95GBU3, RT38CG6624S9ES, NV7B4440VBB/U5, DV90F09F4SU3, QE55Q70CATXZT, VS70H25WFT/WA, WD90T754DBH/S3

Elenca TUTTI i possibili candidati, in ordine di prominenza visiva (più grande/evidente per primo). Sii inclusivo: se qualcosa POTREBBE essere un codice modello, includilo.

ESCLUDI con sicurezza:
- Prezzi (con €, $, virgole decimali)
- EAN/codici a barre (esattamente 8 o 13 cifre, solo numeri)
- Classi energetiche (A, A+, A++, A+++, B, ecc.)
- Watt, kg, litri, dB (es. 1200W, 8KG, 38L, 65DB)
- Anni (1900-2099)
- URL e domini (.com, .it, ecc.)

Rispondi SOLO con JSON valido (no markdown, no backtick, no testo aggiuntivo):
{"candidates":["CODICE1","CODICE2"]}

Se nell'immagine non c'è nulla che assomigli a un codice modello:
{"candidates":[]}`;

      try {
        const fetchPromise = fetch(GEMINI_URL(apiKey, MODEL_OCR), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inline_data: { mime_type: 'image/jpeg', data: image } },
            ]}],
            generationConfig: {
            maxOutputTokens: 300,
            temperature: 0,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
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
        let candidates = [];
        // Tentativo 1: parse JSON pulito
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
          else if (parsed.sku) candidates = [parsed.sku];
        } catch { /* fallback */ }
        // Tentativo 2: estrai un blocco { ... } se presente
        if (!candidates.length) {
          const m = text.match(/\{[\s\S]*\}/);
          if (m) {
            try {
              const parsed = JSON.parse(m[0]);
              if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
              else if (parsed.sku) candidates = [parsed.sku];
            } catch { /* fallback */ }
          }
        }
        // Tentativo 3: regex sul testo grezzo per pattern tipo SKU
        if (!candidates.length) {
          const tokens = (text.toUpperCase().match(/[A-Z0-9]{8,18}(?:\/[A-Z0-9]{2,4})?/g) || []);
          candidates = [...new Set(tokens)];
        }
        return cors(JSON.stringify({ candidates }), 200);
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
