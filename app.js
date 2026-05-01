/* ═══════════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════════ */
const CONFIG = {
  GITHUB_RAW: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? '.'
    : 'https://raw.githubusercontent.com/aceKuno/promoscan/main',
  WORKER_URL: 'https://promoscan.teotramba.workers.dev',
  CONFIDENCE_HIGH: 95,
  CONFIDENCE_MED:  90,
};

/* ═══════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════ */
const state = {
  promoData:     [],
  currentSku:    null,
  currentPromos: [],
  stream:        null,
  scanInterval:  null,
  isScanning:    false,
};

/* ═══════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  bindButtons();
  bindChat();
  await loadPromoData();
});

/* ═══════════════════════════════════════════════════════════
   DATA
═══════════════════════════════════════════════════════════ */
async function loadPromoData() {
  try {
    const resp = await fetch(`${CONFIG.GITHUB_RAW}/data/promos.csv`);
    if (!resp.ok) throw new Error('CSV non trovato');
    state.promoData = parseCSV(await resp.text());
  } catch (e) {
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
  }).filter(r => r.PromoID && r.SKU);
}

function parseCSVLine(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else current += ch;
  }
  result.push(current);
  return result;
}

function searchPromos(sku) {
  const skuNorm = sku.trim().toUpperCase();
  const activeStatuses = ['Live', 'Solo registrazione'];
  return state.promoData.filter(row => {
    if (!activeStatuses.includes(row.Status)) return false;
    const dbSku = row.SKU.toUpperCase();
    if (dbSku === skuNorm) return true;
    if (dbSku.includes('/') && dbSku.split('/')[0] === skuNorm) return true;
    return false;
  });
}

/* ═══════════════════════════════════════════════════════════
   CAMERA
═══════════════════════════════════════════════════════════ */
async function startCamera() {
  setScanStatus('Avvio fotocamera...');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    state.stream = stream;
    const video = document.getElementById('video');
    video.srcObject = stream;
    await video.play();
    setScanStatus('Inquadra il codice prodotto e premi "Scansiona ora"');
    document.getElementById('btn-force-scan').disabled = false;
  } catch (e) {
    setScanStatus('Fotocamera non disponibile. Usa inserimento manuale o carica una foto.');
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

function stopAutoScan() {
  if (state.scanInterval) { clearInterval(state.scanInterval); state.scanInterval = null; }
  state.isScanning = false;
}

async function forceScan() {
  if (state.isScanning) return;
  setScanStatus('Analisi in corso...');
  await runOCR(true);
}

function setScanStatus(msg) {
  const el = document.getElementById('scan-status');
  if (el) el.textContent = msg;
}

/* ═══════════════════════════════════════════════════════════
   OCR VIA GEMINI VISION (1.5-flash)
═══════════════════════════════════════════════════════════ */
async function runOCR(isManual = false) {
  state.isScanning = true;
  setScanStatus('Analisi immagine in corso...');
  const result = await captureAndAnalyze();
  state.isScanning = false;

  // DEBUG — mostra cosa torna dal Worker
  if (result && result._debug) {
    showToast(`DEBUG: ${result._debug}`);
  }

  if (!result || !result.sku) {
    if (isManual) setScanStatus('Codice non trovato. Avvicinati al cartellino e riprova.');
    else setScanStatus('In attesa... punta la fotocamera sul codice e premi "Scansiona ora".');
    return;
  }

  showToast(`OCR: "${result.sku}" (conf: ${result.confidence}%)`);
  handleDetectedCode(result.sku, result.confidence, isManual);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let curr = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, curr + 1, prev[j - 1] + cost);
      prev[j - 1] = curr;
      curr = next;
    }
    prev[b.length] = curr;
  }
  return prev[b.length];
}

function correctSkuAgainstDb(rawSku) {
  if (!rawSku) return null;
  const candidate = rawSku.toUpperCase().trim();
  const candBase = candidate.split('/')[0];

  const knownBaseToFull = new Map();
  for (const row of state.promoData) {
    const full = row.SKU.toUpperCase();
    const base = full.split('/')[0];
    if (!knownBaseToFull.has(base)) knownBaseToFull.set(base, full);
  }

  // Exact match on base
  if (knownBaseToFull.has(candBase)) return knownBaseToFull.get(candBase);

  // Fuzzy match (max 2 edit distance, only same length range)
  let best = null;
  let bestDist = Infinity;
  for (const [base, full] of knownBaseToFull) {
    if (Math.abs(base.length - candBase.length) > 2) continue;
    const dist = levenshtein(candBase, base);
    if (dist < bestDist) { bestDist = dist; best = full; }
  }
  if (best && bestDist <= 2) return best;

  return candidate;
}

async function captureAndAnalyze(imageSource) {
  const canvas = document.getElementById('canvas-hidden');
  const ctx = canvas.getContext('2d');

  let imgEl = imageSource;
  if (!imgEl) {
    const video = document.getElementById('video');
    if (!video) return { sku: null, confidence: 0, _debug: 'video element mancante' };
    if (video.readyState < 2) return { sku: null, confidence: 0, _debug: `video readyState=${video.readyState}` };
    imgEl = video;
  }

  const srcW = imgEl.videoWidth || imgEl.naturalWidth || imgEl.width || 0;
  const srcH = imgEl.videoHeight || imgEl.naturalHeight || imgEl.height || 0;
  if (!srcW || !srcH) return { sku: null, confidence: 0, _debug: `dimensioni=0 (${srcW}x${srcH})` };

  const scale = Math.min(1, 1024 / srcW);
  canvas.width  = Math.floor(srcW * scale);
  canvas.height = Math.floor(srcH * scale);
  ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);

  const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  if (!base64 || base64.length < 100) return { sku: null, confidence: 0, _debug: 'base64 troppo corto' };

  try {
    const resp = await fetch(CONFIG.WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ocr', image: base64 }),
    });
    if (!resp.ok) return { sku: null, confidence: 0, _debug: `HTTP ${resp.status}` };
    const data = await resp.json();
    if (data.error) return { sku: null, confidence: 0, _debug: `ERR ${data.error}` };
    if (!data.sku) return { sku: null, confidence: 0, _debug: 'Gemini: sku=null' };
    const corrected = correctSkuAgainstDb(data.sku);
    return { sku: corrected, confidence: data.confidence, _debug: `raw="${data.sku}" → "${corrected}"` };
  } catch (e) {
    return { sku: null, confidence: 0, _debug: `EXC ${e.message}` };
  }
}

/* ═══════════════════════════════════════════════════════════
   CONFIDENCE ROUTING
═══════════════════════════════════════════════════════════ */
function handleDetectedCode(sku, confidence, isManual) {
  stopAutoScan();

  if (confidence >= CONFIG.CONFIDENCE_HIGH) {
    showScanBadge(`✓ ${sku}`);
    setTimeout(() => processSku(sku), 600);
  } else if (confidence >= CONFIG.CONFIDENCE_MED) {
    state.currentSku = sku;
    document.getElementById('confirm-sku-text').textContent = sku;
    showScreen('confirm');
  } else {
    showScreen('low');
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
   PHOTO UPLOAD FALLBACK
═══════════════════════════════════════════════════════════ */
document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  showLoader('Analisi immagine in corso...');
  const img = new Image();
  img.onload = async () => {
    const result = await captureAndAnalyze(img);
    hideLoader();
    if (result && result.sku) {
      handleDetectedCode(result.sku, result.confidence, true);
    } else {
      showScreen('low');
    }
  };
  img.src = URL.createObjectURL(file);
  e.target.value = '';
});

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
    showScreen('no-result');
  } else {
    document.getElementById('result-sku-code').textContent = sku;
    renderPromos(promos);
    showScreen('result');
  }
}

function renderPromos(promos) {
  const list = document.getElementById('promo-list');
  list.innerHTML = '';
  const grouped = {};
  promos.forEach(p => { if (!grouped[p.PromoID]) grouped[p.PromoID] = p; });
  Object.values(grouped).forEach(p => list.appendChild(buildPromoCard(p)));
}

function buildPromoCard(promo) {
  const card = document.createElement('div');
  card.className = 'promo-card';
  const keyVisualUrl = `${CONFIG.GITHUB_RAW}/promos/${promo.PromoID}/keyvisual.jpg`;

  card.innerHTML = `
    <div class="promo-card-header">
      <div class="promo-badges">
        ${getStatusBadge(promo.Status)}
        ${promo.Cumulabile === 'Si'
          ? '<span class="badge badge-cum-yes"><span class="badge-dot"></span>Cumulabile</span>'
          : '<span class="badge badge-cum-no">Non cumulabile</span>'}
      </div>
      <div class="promo-name">${escapeHtml(promo.PromoName)}</div>
      <div class="promo-dates">
        <div class="promo-date-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          Promo: ${promo.StartDate} → ${promo.EndDate}
        </div>
        ${promo.RegistrationEnd ? `
        <div class="promo-date-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Registrazione entro: ${promo.RegistrationEnd}
        </div>` : ''}
      </div>
    </div>
    <div class="promo-keyvisual">
      <img src="${keyVisualUrl}" alt="Key visual"
        onerror="this.parentElement.innerHTML='<div class=\\'promo-keyvisual-placeholder\\'>Key visual non ancora caricato</div>'"
        loading="lazy" style="max-height:240px;object-fit:cover;">
    </div>`;
  return card;
}

function getStatusBadge(status) {
  const map = {
    'Live':               '<span class="badge badge-live"><span class="badge-dot"></span>Attiva</span>',
    'Solo registrazione': '<span class="badge badge-reg"><span class="badge-dot"></span>Solo registrazione</span>',
    'In partenza':        '<span class="badge badge-soon"><span class="badge-dot"></span>In arrivo</span>',
  };
  return map[status] || `<span class="badge badge-cum-no">${escapeHtml(status)}</span>`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str || ''));
  return d.innerHTML;
}

/* ═══════════════════════════════════════════════════════════
   SPEECH — MICROFONO E SINTESI VOCALE
═══════════════════════════════════════════════════════════ */
let isRecording = false;
let activeRecognition = null;

function startRecording(inputId, btnEl, screen) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showToast('Riconoscimento vocale non supportato. Usa Chrome.');
    return;
  }
  if (isRecording) { if (activeRecognition) activeRecognition.stop(); return; }

  const recognition = new SR();
  recognition.lang = 'it-IT';
  recognition.continuous = false;
  recognition.interimResults = false;
  activeRecognition = recognition;
  isRecording = true;
  btnEl.classList.add('recording');

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    const input = document.getElementById(inputId);
    if (input) input.value = transcript;
    // Auto-invia dopo riconoscimento vocale (con piccolo delay)
    setTimeout(() => sendChat(screen, true), 400);
  };

  recognition.onend = () => {
    isRecording = false;
    activeRecognition = null;
    btnEl.classList.remove('recording');
  };

  recognition.onerror = (e) => {
    isRecording = false;
    activeRecognition = null;
    btnEl.classList.remove('recording');
    if (e.error === 'not-allowed') showToast('Permesso microfono negato. Abilitalo nelle impostazioni del browser.');
    else if (e.error !== 'no-speech') showToast('Errore microfono: ' + e.error);
  };

  try { recognition.start(); }
  catch { isRecording = false; btnEl.classList.remove('recording'); }
}

function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'it-IT';
  utterance.rate = 1.0;
  // Aspetta voices (necessario su alcuni browser)
  const trySpeak = () => {
    const voices = window.speechSynthesis.getVoices();
    const italianVoice = voices.find(v => v.lang.startsWith('it'));
    if (italianVoice) utterance.voice = italianVoice;
    window.speechSynthesis.speak(utterance);
  };
  if (window.speechSynthesis.getVoices().length > 0) trySpeak();
  else window.speechSynthesis.onvoiceschanged = trySpeak;
}

/* ═══════════════════════════════════════════════════════════
   AI CHAT
═══════════════════════════════════════════════════════════ */
function bindChat() {
  document.getElementById('btn-send').addEventListener('click', () => sendChat('result', false));
  document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat('result', false); });
  document.getElementById('btn-mic').addEventListener('click', e => startRecording('chat-input', e.currentTarget, 'result'));

  document.getElementById('btn-send-nr').addEventListener('click', () => sendChat('no-result', false));
  document.getElementById('chat-input-nr').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat('no-result', false); });
  document.getElementById('btn-mic-nr').addEventListener('click', e => startRecording('chat-input-nr', e.currentTarget, 'no-result'));
}

async function sendChat(screen, isVoice = false) {
  const inputId    = screen === 'result' ? 'chat-input'    : 'chat-input-nr';
  const messagesId = screen === 'result' ? 'chat-messages' : 'chat-messages-nr';
  const input = document.getElementById(inputId);
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  appendChatMsg(messagesId, question, 'user');
  const typingEl = appendChatMsg(messagesId, 'Sto cercando la risposta...', 'typing');

  const promoIds     = [...new Set(state.currentPromos.map(p => p.PromoID))];
  const promosSummary = state.currentPromos.map(p => ({
    id: p.PromoID, nome: p.PromoName, stato: p.Status,
    inizio: p.StartDate, fine: p.EndDate,
    scadenzaRegistrazione: p.RegistrationEnd, cumulabile: p.Cumulabile,
  }));

  try {
    const resp = await fetch(CONFIG.WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'chat', sku: state.currentSku, promos: promosSummary, promoIds, question }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { answer } = await resp.json();
    typingEl.remove();
    const msgEl = appendChatMsg(messagesId, answer, 'assistant');
    if (isVoice) speak(answer);
    if (window.speechSynthesis) {
      const speakBtn = document.createElement('button');
      speakBtn.className = 'msg-speak';
      speakBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> Riascolta`;
      speakBtn.addEventListener('click', () => speak(answer));
      msgEl.appendChild(speakBtn);
    }
  } catch {
    typingEl.remove();
    appendChatMsg(messagesId, 'Servizio AI non disponibile. Controlla la connessione.', 'assistant');
  }

  const container = document.getElementById(messagesId);
  container.scrollTop = container.scrollHeight;
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
  const t = document.getElementById(`screen-${name}`);
  if (t) t.classList.add('active');
}

function bindButtons() {
  document.getElementById('btn-start-scan').addEventListener('click', () => { showScreen('scan'); startCamera(); startAutoScan(); });
  document.getElementById('btn-home-manual').addEventListener('click', () => showScreen('manual'));
  document.getElementById('btn-scan-back').addEventListener('click', () => { stopCamera(); showScreen('home'); });
  document.getElementById('btn-force-scan').addEventListener('click', forceScan);
  document.getElementById('btn-upload-photo').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('btn-scan-to-manual').addEventListener('click', () => { stopCamera(); showScreen('manual'); });
  document.getElementById('btn-confirm-yes').addEventListener('click', () => processSku(state.currentSku));
  document.getElementById('btn-confirm-no').addEventListener('click', () => { state.currentSku = null; showScreen('scan'); startCamera(); startAutoScan(); });
  document.getElementById('btn-confirm-manual').addEventListener('click', () => { stopCamera(); showScreen('manual'); });
  document.getElementById('btn-low-scan-serial').addEventListener('click', () => { showScreen('scan'); setScanStatus('Inquadra il seriale del prodotto'); startCamera(); startAutoScan(); });
  document.getElementById('btn-low-retry').addEventListener('click', () => { showScreen('scan'); startCamera(); startAutoScan(); });
  document.getElementById('btn-low-manual').addEventListener('click', () => { stopCamera(); showScreen('manual'); });
  document.getElementById('btn-manual-back').addEventListener('click', () => { showScreen('scan'); startCamera(); startAutoScan(); });
  document.getElementById('btn-manual-search').addEventListener('click', () => {
    const sku = document.getElementById('manual-input').value.trim().toUpperCase();
    if (!sku) return;
    processSku(sku);
    document.getElementById('manual-input').value = '';
  });
  document.getElementById('manual-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-manual-search').click(); });
  document.getElementById('btn-result-back').addEventListener('click', () => { state.currentSku = null; state.currentPromos = []; showScreen('home'); });
  document.getElementById('btn-noresult-back').addEventListener('click', () => { state.currentSku = null; showScreen('home'); });
  document.getElementById('btn-noresult-new-scan').addEventListener('click', () => { state.currentSku = null; showScreen('scan'); startCamera(); startAutoScan(); });
}

/* ═══════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════ */
function showLoader(text = 'Caricamento...') {
  document.getElementById('loader-text').textContent = text;
  document.getElementById('loader').classList.remove('hidden');
}

function hideLoader() { document.getElementById('loader').classList.add('hidden'); }

function showToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:12px 20px;border-radius:999px;font-size:13px;z-index:200;max-width:300px;text-align:center;';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
