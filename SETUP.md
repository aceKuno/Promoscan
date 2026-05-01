# PromoScan — Guida al Deploy

## Passo 1 — Crea il repository GitHub

1. Vai su github.com → **New repository**
2. Nome: `promoscan`
3. Visibilità: **Public** (necessario per GitHub Pages)
4. Clicca **Create repository**
5. Carica tutti i file di questa cartella tramite il pulsante **Upload files**

## Passo 2 — Abilita GitHub Pages

1. Nel repository → **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `main`, cartella: `/ (root)`
4. Clicca **Save**
5. L'URL sarà: `https://TUONOME.github.io/promoscan`

## Passo 3 — Deploy del Cloudflare Worker

1. Vai su dash.cloudflare.com → **Workers & Pages** → **Create**
2. Scegli **Create Worker**
3. Copia il contenuto di `worker/index.js` nell'editor
4. Clicca **Deploy**
5. Vai in **Settings** → **Variables** → aggiungi:
   - `ANTHROPIC_API_KEY` = la tua chiave da console.anthropic.com
   - `GITHUB_REPO` = `TUONOME/promoscan`
6. Nota l'URL del worker (es: `https://promoscan.TUONOME.workers.dev`)

## Passo 4 — Configura app.js

Apri `app.js` e modifica le prime righe:

```javascript
GITHUB_RAW: 'https://raw.githubusercontent.com/TUONOME/promoscan/main',
WORKER_URL: 'https://promoscan.TUONOME.workers.dev',
```

Sostituisci `TUONOME` con il tuo username GitHub.
Poi fai upload del file aggiornato su GitHub.

## Passo 5 — Aggiornamento database promo

1. Il team aggiorna l'Excel → esegue il VBA → produce `promos.csv`
2. Vai su github.com/TUONOME/promoscan → cartella `data/`
3. Clicca su `promos.csv` → icona matita (edit) → incolla il nuovo contenuto → **Commit**

Oppure usa GitHub Desktop per aggiornamenti più frequenti.

## Aggiungere key visual e T&C di una promo

1. Vai su github.com/TUONOME/promoscan → cartella `promos/`
2. Crea cartella `PROMOID/` (es. `13498/`)
3. Carica `keyvisual.jpg` e `tc.txt` nella cartella

## URL finale dell'app

`https://TUONOME.github.io/promoscan`

Da condividere con RSHA e commessi. Nessuna installazione richiesta.
