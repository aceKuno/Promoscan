/* ═══════════════════════════════════════════════════════════
   CONFIG — aggiorna questi valori dopo il deploy su GitHub
═══════════════════════════════════════════════════════════ */
const CONFIG = {
  // URL base del repo su GitHub (raw content)
  // Es: 'https://raw.githubusercontent.com/tuonome/promoscan/main'
  GITHUB_RAW: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? '.'
    : 'https://raw.githubusercontent.com/aceKuno/promoscan/main',

  // URL del Cloudflare Worker
  WORKER_URL: 'https://promoscan.teotramba.workers.dev',

  // Soglie confidenza OCR
  CONFIDENCE_HIGH: 95,
  CONFIDENCE_MED: 90,

  // Pattern codici prodotto (es. RB38C607AS9/EF, WW11DB8B95GBU3)
  SKU_PATTERN: /\b([A-Z]{2}[0-9][A-Z0-9]{7,12}(?:\/[A-Z0-9]{2,3})?)\b/g,
};

/* ═══════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════ */
const state = {
  promoData: [],
  currentSku: null,
  currentPromos: [],
  stream: null,
  tesseractWorker: null,
  scanInterval: null,
  isOcrReady: false,
  isScanning: false,
  activeChat: null,   // 'result' | 'no-result'
};

/* ═══════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  bindButtons();
  bindChat();
  await loadPromoData();
  initOCR();
});

/* ═══════════════════════════════════════════════════════════
   DATA LOADING
═══════════════════════════════════════════════════════════ */
async function loadPromoData() {
  try {
    const resp = await fetch(`${CONFIG.GITHUB_RAW}/data/promos.csv`);
    if (!resp.ok) throw new Error('CSV non trovato');
    const text = await resp.text();
    state.promoData = parseCSV(text);
  } catch (e) {
    console.error('Errore caricamento dati:', e);
    showToast('Errore nel caricamento del database promo. Controlla la connessione.');
  }
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (values[i] || '').trim(); });
    return obj;
  }).filter(row => row.PromoID && row.SKU);
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function searchPromos(sku) {
  const skuNorm = sku.trim().toUpperCase();
  const activeStatuses = ['Live', 'Solo registrazione'];
  return state.promoData.filter(row => {
    return row.SKU.toUpperCase() === skuNorm && activeStatuses.includes(row.Status);
  });
}

/* ═══════════════════════════════════════════════════════════
   OCR — TESSERACT.JS
═══════════════════════════════════════════════════════════ */
async function initOCR() {
  try {
    state.tesseractWorker = await Tesseract.createWorker('eng', 1, {
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
    });
    await state.tesseractWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/',
      tessedit_pageseg_mode: '6',
    });
    state.isOcrReady = true;
    const btn = document.getElementById('btn-force-scan');
    if (btn) btn.disabled = false;
    setScanStatus('Fotocamera pronta. Inquadra il codice prodotto.');
  } catch (e) {
    console.error('OCR init error:', e);
    setScanStatus('Errore inizializzazione OCR. Usa inserimento manuale.');
  }
}

async function analyzeFrame(imageSource) {
  if (!state.tesseractWorker || !state.isOcrReady) return null;

  const canvas = document.getElementById('canvas-hidden');
  const ctx = canvas.getContext('2d');

  let imgEl = imageSource;
  if (!imageSource) {
    const video = document.getElementById('video');
    if (!video || video.readyState < 2) return null;
    imgEl = video;
  }

  // Crop center region for faster OCR
  const srcW = imgEl.videoWidth || imgEl.naturalWidth || imgEl.width;
  const srcH = imgEl.videoHeight || imgEl.naturalHeight || imgEl.height;
  const cropW = Math.floor(srcW * 0.8);
  const cropH = Math.floor(srcH * 0.35);
  const cropX = Math.floor((srcW - cropW) / 2);
  const cropY = Math.floor((srcH - cropH) / 2);

  canvas.width = cropW;
  canvas.height = cropH;
  ctx.drawImage(imgEl, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  // Grayscale + contrast boost
  const imgData = ctx.getImageData(0, 0, cropW, cropH);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const contrast = Math.min(255, Math.max(0, (gray - 128) * 1.6 + 128));
    d[i] = d[i + 1] = d[i + 2] = contrast;
  }
  ctx.putImageData(imgData, 0, 0);

  try {
    const { data } = await state.tesseractWorker.recognize(canvas);
    return extractSKU(data);
  } catch (e) {
    return null;
  }
}

function extractSKU(tessData) {
  if (!tessData || !tessData.words || tessData.words.length === 0) return null;

  // Try matching individual words
  const candidates = [];
  const words = tessData.words;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const text = word.text.toUpperCase().replace(/[^A-Z0-9/]/g, '');

    // Direct match
    const matches = [...text.matchAll(CONFIG.SKU_PATTERN)];
    if (matches.length > 0) {
      candidates.push({ sku: matches[0][1], confidence: word.confidence });
    }

    // Try combining with next word via slash (e.g. "RB38C607AS9" + "EF" → "RB38C607AS9/EF")
    if (i < words.length - 1) {
      const next = words[i + 1].text.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const combined = text + '/' + next;
      const mCombined = [...combined.matchAll(CONFIG.SKU_PATTERN)];
      if (mCombined.length > 0) {
        const conf = Math.min(word.confidence, words[i + 1].confidence);
        candidates.push({ sku: mCombined[0][1], confidence: conf });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Return highest confidence candidate
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0];
}

/* ═══════════════════════════════════════════════════════════
   CAMERA
═══════════════════════════════════════════════════════════ */
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    state.stream = stream;
    const video = document.getElementById('video');
    video.srcObject = stream;
    await video.play();
    startAutoScan();
  } catch (e) {
    setScanStatus('Fotocamera non disponibile. Usa inserimento manuale o carica una foto.');
    console.error('Camera error:', e);
  }
}

function stopCamera() {
  stopAutoScan();
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  const video = document.getElementById('video');
  if (video) video.srcObject = null;
}

function startAutoScan() {
  stopAutoScan();
  state.scanInterval = setInterval(async () => {
    if (state.isScanning) return;
    state.isScanning = true;
    const result = await analyzeFrame(null);
    state.isScanning = false;
    if (result) {
      handleDetectedCode(result.sku, result.confidence, false);
    }
  }, 2000);
}

function stopAutoScan() {
  if (state.scanInterval) {
    clearInterval(state.scanInterval);
    state.scanInterval = null;
  }
  state.isScanning = false;
}

async function forceScan() {
  if (state.isScanning) return;
  state.isScanning = true;
  setScanStatus('Analisi in corso...');
  const result = await analyzeFrame(null);
  state.isScanning = false;
  if (result) {
    handleDetectedCode(result.sku, result.confidence, true);
  } else {
    setScanStatus('Codice non rilevato. Avvicinati al cartellino e riprova.');
  }
}

function setScanStatus(msg) {
  const el = document.getElementById('scan-status');
  if (el) el.textContent = msg;
}

/* ═══════════════════════════════════════════════════════════
   CONFIDENCE ROUTING
═══════════════════════════════════════════════════════════ */
function handleDetectedCode(sku, confidence, isManualTrigger) {
  stopAutoScan();

  if (confidence >= CONFIG.CONFIDENCE_HIGH) {
    // Auto-proceed
    showScanBadge(`✓ ${sku} — ${Math.round(confidence)}%`);
    setTimeout(() => processSku(sku), 600);
  } else if (confidence >= CONFIG.CONFIDENCE_MED) {
    // Ask confirmation
    document.getElementById('confirm-sku-text').textContent = sku;
    showScreen('confirm');
    state.currentSku = sku;
  } else {
    // Low confidence
    if (isManualTrigger) {
      showScreen('low');
    } else {
      setScanStatus(`Bassa confidenza (${Math.round(confidence)}%). Inquadra meglio il codice.`);
      startAutoScan();
    }
  }
}

function showScanBadge(text) {
  const badge = document.getElementById('scan-badge');
  const badgeText = document.getElementById('scan-badge-text');
  if (badge && badgeText) {
    badgeText.textContent = text;
    badge.classList.remove('hidden');
    setTimeout(() => badge.classList.add('hidden'), 2000);
  }
}

/* ═══════════════════════════════════════════════════════════
   SKU LOOKUP & RESULT
═══════════════════════════════════════════════════════════ */
function processSku(sku) {
  stopCamera();
  state.currentSku = sku;
  const promos = searchPromos(sku);
  state.currentPromos = promos;

  if (promos.length === 0) {
    document.getElementById('no-result-sku').textContent = sku;
    state.activeChat = 'no-result';
    showScreen('no-result');
  } else {
    document.getElementById('result-sku-code').textContent = sku;
    renderPromos(promos);
    state.activeChat = 'result';
    showScreen('result');
  }
}

function renderPromos(promos) {
  const list = document.getElementById('promo-list');
  list.innerHTML = '';

  // Group by PromoID (one card per promo, even if multiple SKUs)
  const grouped = {};
  promos.forEach(p => {
    if (!grouped[p.PromoID]) grouped[p.PromoID] = p;
  });

  Object.values(grouped).forEach(promo => {
    const card = buildPromoCard(promo);
    list.appendChild(card);
  });
}

function buildPromoCard(promo) {
  const card = document.createElement('div');
  card.className = 'promo-card';

  const statusBadge = getStatusBadge(promo.Status);
  const cumBadge = promo.Cumulabile === 'Si'
    ? `<span class="badge badge-cum-yes"><span class="badge-dot"></span>Cumulabile</span>`
    : `<span class="badge badge-cum-no">Non cumulabile</span>`;

  const keyVisualUrl = `${CONFIG.GITHUB_RAW}/promos/${promo.PromoID}/keyvisual.jpg`;

  card.innerHTML = `
    <div class="promo-card-header">
      <div class="promo-badges">
        ${statusBadge}
        ${cumBadge}
      </div>
      <div class="promo-name">${escapeHtml(promo.PromoName)}</div>
      <div class="promo-dates">
        <div class="promo-date-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          Promo: ${formatDate(promo.StartDate)} → ${formatDate(promo.EndDate)}
        </div>
        ${promo.RegistrationEnd ? `
        <div class="promo-date-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Registrazione entro: ${formatDate(promo.RegistrationEnd)}
        </div>` : ''}
      </div>
    </div>
    <div class="promo-keyvisual" id="kv-${promo.PromoID}">
      <img
        src="${keyVisualUrl}"
        alt="Key visual ${escapeHtml(promo.PromoName)}"
        onerror="this.parentElement.innerHTML='<div class=\\'promo-keyvisual-placeholder\\'>Key visual non ancora caricato</div>'"
        loading="lazy"
        style="max-height:240px; object-fit:cover;"
      >
    </div>
  `;

  return card;
}

function getStatusBadge(status) {
  switch (status) {
    case 'Live':
      return `<span class="badge badge-live"><span class="badge-dot"></span>Attiva</span>`;
    case 'Solo registrazione':
      return `<span class="badge badge-reg"><span class="badge-dot"></span>Solo registrazione</span>`;
    case 'In partenza':
      return `<span class="badge badge-soon"><span class="badge-dot"></span>In arrivo</span>`;
    default:
      return `<span class="badge badge-cum-no">${escapeHtml(status)}</span>`;
  }
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  // Input: DD/MM/YYYY or similar
  return dateStr;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str || ''));
  return div.innerHTML;
}

/* ═══════════════════════════════════════════════════════════
   PHOTO UPLOAD FALLBACK
═══════════════════════════════════════════════════════════ */
document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  showLoader('Analisi immagine in corso...');
  const img = new Image();
  img.onload = async () => {
    const result = await analyzeFrame(img);
    hideLoader();
    if (result && result.confidence >= CONFIG.CONFIDENCE_MED) {
      handleDetectedCode(result.sku, result.confidence, true);
    } else if (result) {
      state.currentSku = result.sku;
      document.getElementById('confirm-sku-text').textContent = result.sku;
      showScreen('confirm');
    } else {
      showScreen('low');
    }
  };
  img.src = URL.createObjectURL(file);
  e.target.value = '';
});

/* ═══════════════════════════════════════════════════════════
   AI CHAT
═══════════════════════════════════════════════════════════ */
function bindChat() {
  // Result screen chat
  const sendBtn = document.getElementById('btn-send');
  const chatInput = document.getElementById('chat-input');
  sendBtn.addEventListener('click', () => sendChat('result'));
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat('result'); });

  // No-result screen chat
  const sendBtnNr = document.getElementById('btn-send-nr');
  const chatInputNr = document.getElementById('chat-input-nr');
  sendBtnNr.addEventListener('click', () => sendChat('no-result'));
  chatInputNr.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat('no-result'); });
}

async function sendChat(screen) {
  const inputId = screen === 'result' ? 'chat-input' : 'chat-input-nr';
  const messagesId = screen === 'result' ? 'chat-messages' : 'chat-messages-nr';

  const input = document.getElementById(inputId);
  const question = input.value.trim();
  if (!question) return;

  input.value = '';
  appendChatMsg(messagesId, question, 'user');

  const typingEl = appendChatMsg(messagesId, 'Sto cercando la risposta...', 'typing');

  const promoIds = [...new Set(state.currentPromos.map(p => p.PromoID))];
  const promosSummary = state.currentPromos.map(p => ({
    id: p.PromoID,
    nome: p.PromoName,
    stato: p.Status,
    inizio: p.StartDate,
    fine: p.EndDate,
    scadenzaRegistrazione: p.RegistrationEnd,
    cumulabile: p.Cumulabile,
  }));

  try {
    const resp = await fetch(CONFIG.WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: state.currentSku,
        promos: promosSummary,
        promoIds,
        question,
      }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { answer } = await resp.json();
    typingEl.remove();
    appendChatMsg(messagesId, answer, 'assistant');
  } catch (e) {
    typingEl.remove();
    appendChatMsg(messagesId, 'Servizio AI non disponibile. Assicurati che il Worker URL sia configurato correttamente.', 'assistant');
  }

  const msgContainer = document.getElementById(messagesId);
  msgContainer.scrollTop = msgContainer.scrollHeight;
}

function appendChatMsg(containerId, text, role) {
  const container = document.getElementById(containerId);
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  msg.textContent = text;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  return msg;
}

/* ═══════════════════════════════════════════════════════════
   SCREEN NAVIGATION
═══════════════════════════════════════════════════════════ */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`screen-${name}`);
  if (target) target.classList.add('active');
}

function bindButtons() {
  // HOME
  document.getElementById('btn-start-scan').addEventListener('click', () => {
    showScreen('scan');
    startCamera();
  });
  document.getElementById('btn-home-manual').addEventListener('click', () => {
    showScreen('manual');
  });

  // SCAN
  document.getElementById('btn-scan-back').addEventListener('click', () => {
    stopCamera();
    showScreen('home');
  });
  document.getElementById('btn-force-scan').addEventListener('click', forceScan);
  document.getElementById('btn-upload-photo').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });
  document.getElementById('btn-scan-to-manual').addEventListener('click', () => {
    stopCamera();
    showScreen('manual');
  });

  // CONFIRM
  document.getElementById('btn-confirm-yes').addEventListener('click', () => {
    processSku(state.currentSku);
  });
  document.getElementById('btn-confirm-no').addEventListener('click', () => {
    state.currentSku = null;
    showScreen('scan');
    startCamera();
  });
  document.getElementById('btn-confirm-manual').addEventListener('click', () => {
    stopCamera();
    showScreen('manual');
  });

  // LOW CONFIDENCE
  document.getElementById('btn-low-scan-serial').addEventListener('click', () => {
    showScreen('scan');
    setScanStatus('Inquadra il seriale del prodotto (di solito sul retro o all\'interno)');
    startCamera();
  });
  document.getElementById('btn-low-retry').addEventListener('click', () => {
    showScreen('scan');
    startCamera();
  });
  document.getElementById('btn-low-manual').addEventListener('click', () => {
    stopCamera();
    showScreen('manual');
  });

  // MANUAL
  document.getElementById('btn-manual-back').addEventListener('click', () => {
    showScreen('scan');
    startCamera();
  });
  document.getElementById('btn-manual-search').addEventListener('click', () => {
    const sku = document.getElementById('manual-input').value.trim().toUpperCase();
    if (!sku) return;
    processSku(sku);
    document.getElementById('manual-input').value = '';
  });
  document.getElementById('manual-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-manual-search').click();
  });

  // RESULT
  document.getElementById('btn-result-back').addEventListener('click', () => {
    state.currentSku = null;
    state.currentPromos = [];
    showScreen('home');
  });

  // NO RESULT
  document.getElementById('btn-noresult-back').addEventListener('click', () => {
    state.currentSku = null;
    showScreen('home');
  });
  document.getElementById('btn-noresult-new-scan').addEventListener('click', () => {
    state.currentSku = null;
    showScreen('scan');
    startCamera();
  });
}

/* ═══════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════ */
function showLoader(text = 'Caricamento...') {
  const loader = document.getElementById('loader');
  document.getElementById('loader-text').textContent = text;
  loader.classList.remove('hidden');
}

function hideLoader() {
  document.getElementById('loader').classList.add('hidden');
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
    background:#333; color:#fff; padding:12px 20px; border-radius:999px;
    font-size:13px; z-index:200; max-width:300px; text-align:center;
    animation: fadeIn 0.2s ease;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
