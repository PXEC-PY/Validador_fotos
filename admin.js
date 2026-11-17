// Panel admin.
//
// Seguridad (OWASP):
//  - A03 XSS: TODO dato que viene de Firestore (lo escribió un usuario
//    anónimo) o de un QR escaneado se pinta escapado con esc() o textContent.
//  - URLs de fotos: solo se usan si apuntan a nuestra cuenta de Cloudinary.
//  - A07 sesión: persistencia solo de pestaña + cierre por inactividad.
//  - Sin scripts inline (CSP estricta en admin.html).
import { auth, db, CLOUDINARY_URL_PREFIX } from './firebase-config.js';
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserSessionPersistence
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  collection, query, where, orderBy, onSnapshot, doc, getDoc, getDocs, updateDoc, serverTimestamp, limit
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

if (window.top !== window.self) {
  document.documentElement.style.display = 'none';
  throw new Error('Esta página no puede mostrarse dentro de un frame.');
}

const $ = (id) => document.getElementById(id);
const loginWrap = $('loginWrap');
const noAuthWrap = $('noAuthWrap');
const dashboard = $('dashboard');

const INACTIVIDAD_MS = 30 * 60 * 1000;
const TICKET_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const QR_RE = /^([A-HJKMNP-Z2-9]{6})-(\d{2})$/;

const state = { lotes: [], selectedLoteId: null, statusFilter: 'todos', search: '' };
let unsubscribeLotes = null;

/* Helpers de seguridad -------------------------------------------------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);

function urlFotoSegura(u) {
  if (typeof u !== 'string' || !u.startsWith(CLOUDINARY_URL_PREFIX)) return null;
  return /^[A-Za-z0-9_./-]+$/.test(u.slice(CLOUDINARY_URL_PREFIX.length)) ? u : null;
}
// Miniatura liviana para la grilla; el original (máxima calidad) se abre al
// hacer click y es lo que se exporta en el ZIP.
const urlMiniatura = (u) => CLOUDINARY_URL_PREFIX + 'c_fill,w_360,h_480,q_auto,f_auto/' + u.slice(CLOUDINARY_URL_PREFIX.length);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmtFecha = (ts) => (ts && ts.toDate ? ts.toDate().toLocaleString('es-PY') : '—');

/* Auth ------------------------------------------------------------------ */

setPersistence(auth, browserSessionPersistence).catch(() => {});

async function login() {
  const email = $('emailInput').value.trim();
  const pass = $('passInput').value;
  const errEl = $('loginError');
  errEl.textContent = '';
  if (!email || !pass) { errEl.textContent = 'Completá email y contraseña.'; return; }
  $('btnLogin').disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    $('passInput').value = '';
  } catch (e) {
    // Mensaje genérico: no revelar si el email existe (A07).
    errEl.textContent = e && e.code === 'auth/too-many-requests'
      ? 'Demasiados intentos. Esperá unos minutos.'
      : 'No se pudo iniciar sesión: revisá el email y la contraseña.';
  } finally {
    $('btnLogin').disabled = false;
  }
}

$('btnLogin').addEventListener('click', login);
$('passInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('btnLogout').addEventListener('click', () => signOut(auth));
$('btnLogoutNoAuth').addEventListener('click', () => signOut(auth));

let idleTimer = null;
function reiniciarInactividad() {
  clearTimeout(idleTimer);
  if (auth.currentUser) idleTimer = setTimeout(() => signOut(auth), INACTIVIDAD_MS);
}
['pointerdown', 'keydown', 'scroll'].forEach((ev) => window.addEventListener(ev, reiniciarInactividad, { passive: true }));

onAuthStateChanged(auth, async (user) => {
  loginWrap.classList.add('hidden');
  noAuthWrap.classList.add('hidden');
  dashboard.classList.add('hidden');
  if (unsubscribeLotes) { unsubscribeLotes(); unsubscribeLotes = null; }
  state.lotes = [];
  state.selectedLoteId = null;
  $('detailContent').innerHTML = '<div class="detail__empty">Seleccioná un lote de la lista para ver su detalle.</div>';

  if (!user) { clearTimeout(idleTimer); loginWrap.classList.remove('hidden'); return; }
  // Un usuario anónimo (el de index.html) nunca es admin.
  if (user.isAnonymous) { loginWrap.classList.remove('hidden'); return; }

  let esAdmin = false;
  try { esAdmin = (await getDoc(doc(db, 'admins', user.uid))).exists(); } catch (_) { esAdmin = false; }
  if (!esAdmin) { noAuthWrap.classList.remove('hidden'); return; }

  dashboard.classList.remove('hidden');
  reiniciarInactividad();
  suscribirLotes();
});

/* Lista de lotes -------------------------------------------------------- */

function suscribirLotes() {
  const q = query(collection(db, 'lotes'), orderBy('createdAt', 'desc'), limit(500));
  unsubscribeLotes = onSnapshot(q, (snap) => {
    state.lotes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
    if (state.selectedLoteId) renderDetail(state.selectedLoteId);
  }, (err) => {
    console.error(err);
    $('emptyState').textContent = 'No se pudieron cargar los lotes (permisos o conexión).';
    $('emptyState').style.display = '';
  });
}

function matchesFilters(lote) {
  if (state.statusFilter !== 'todos' && lote.status !== state.statusFilter) return false;
  if (state.search) {
    const s = state.search.toLowerCase();
    return [lote.ticketCode, lote.patente, lote.agente].some(v => String(v || '').toLowerCase().includes(s));
  }
  return true;
}

function statusBadge(status) {
  if (status === 'aprobado') return '<span class="badge green">🟢 Aprobado</span>';
  if (status === 'rechazado') return '<span class="badge red">🔴 Rechazado</span>';
  return '<span class="badge yellow">🟡 Pendiente</span>';
}

function renderList() {
  const list = $('list');
  const emptyState = $('emptyState');
  list.querySelectorAll('.row').forEach(r => r.remove());

  const visible = state.lotes.filter(matchesFilters);
  if (state.lotes.length === 0 || visible.length === 0) {
    emptyState.textContent = state.lotes.length === 0 ? 'Todavía no hay lotes cargados.' : 'Ningún lote coincide con el filtro/búsqueda.';
    emptyState.style.display = '';
    return;
  }
  emptyState.style.display = 'none';

  for (const lote of visible) {
    const row = document.createElement('div');
    row.className = 'row' + (lote.id === state.selectedLoteId ? ' selected' : '');
    row.tabIndex = 0;
    row.innerHTML = `
      <div class="row__top">
        <span class="row__ticket">${esc(lote.ticketCode || '—')}</span>
        ${statusBadge(lote.status)}
      </div>
      <div class="row__sub">${esc(lote.agente || 'sin agente')} · ${esc(lote.patente || 'sin patente')} · ${esc(num(lote.fotoCount) ?? 0)} fotos · ${esc(fmtFecha(lote.createdAt))}</div>`;
    const abrir = () => {
      state.selectedLoteId = lote.id;
      renderList();
      renderDetail(lote.id);
      $('detailPanel').classList.add('open');
    };
    row.addEventListener('click', abrir);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') abrir(); });
    list.appendChild(row);
  }
}

$('searchInput').addEventListener('input', (e) => { state.search = e.target.value.slice(0, 80); renderList(); });
document.querySelectorAll('.chip[data-status]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip[data-status]').forEach(c => c.setAttribute('aria-pressed', 'false'));
    chip.setAttribute('aria-pressed', 'true');
    state.statusFilter = chip.dataset.status;
    renderList();
  });
});

/* Detalle de un lote ---------------------------------------------------- */

async function cargarFotos(loteId) {
  const snap = await getDocs(collection(db, 'lotes', loteId, 'fotos'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (num(a.order) || 0) - (num(b.order) || 0));
}

async function renderDetail(loteId) {
  const content = $('detailContent');
  const lote = state.lotes.find(l => l.id === loteId);
  if (!lote) { content.innerHTML = '<div class="detail__empty">Lote no encontrado.</div>'; return; }

  // No re-renderizar si el admin está escribiendo una nota.
  const notaActual = $('adminNota');
  const notaEnEdicion = notaActual && document.activeElement === notaActual ? notaActual.value : null;

  content.innerHTML = '<div class="detail__empty">Cargando fotos…</div>';
  let fotos;
  try { fotos = await cargarFotos(loteId); }
  catch (e) { content.innerHTML = '<div class="detail__empty">No se pudieron cargar las fotos.</div>'; return; }
  if (state.selectedLoteId !== loteId) return;

  const ubic = lote.ubicacion || null;
  const lat = ubic ? num(ubic.lat) : null;
  const lng = ubic ? num(ubic.lng) : null;
  const acc = ubic ? num(ubic.accuracy) : null;

  const totalBytes = fotos.reduce((s, f) => s + (num(f.bytes) || 0), 0);

  content.innerHTML = `
    <div class="detail__title">${esc(lote.ticketCode || '—')}</div>
    <div>${statusBadge(lote.status)}</div>
    <div class="section">
      <h3>Datos del lote</h3>
      <table class="kv">
        <tr><td>Agente / broker</td><td>${esc(lote.agente || '—')}</td></tr>
        <tr><td>Patente</td><td>${esc(lote.patente || '—')}</td></tr>
        <tr><td>Fecha de carga</td><td>${esc(fmtFecha(lote.createdAt))}</td></tr>
        <tr><td>Cantidad de fotos</td><td>${esc(fotos.length)} de ${esc(num(lote.fotoCount) ?? '—')}</td></tr>
        <tr><td>Peso total</td><td>${totalBytes ? esc((totalBytes / 1048576).toFixed(1) + ' MB') : '—'}</td></tr>
        <tr><td>Navegador (user agent)</td><td style="font-size:10.5px;">${esc(lote.userAgent || '—')}</td></tr>
      </table>
    </div>
    <div class="section">
      <h3>Ubicación</h3>
      ${lat !== null && lng !== null ? `
        <table class="kv">
          <tr><td>Coordenadas</td><td>${esc(lat.toFixed(6))}, ${esc(lng.toFixed(6))}</td></tr>
          <tr><td>Precisión</td><td>${acc !== null ? '±' + esc(Math.round(acc)) + ' m' : '—'}</td></tr>
        </table>
        <div class="btn-row" style="margin-top:6px;"><a class="link-btn" href="https://www.google.com/maps?q=${encodeURIComponent(lat + ',' + lng)}" target="_blank" rel="noopener noreferrer">Ver en el mapa</a></div>`
        : '<p class="no-data">Sin datos de ubicación.</p>'}
    </div>
    <div class="section"><h3>Fotos <span style="text-transform:none; font-weight:400; color:var(--text-faint);">(click para ver el original)</span></h3><div class="foto-grid" id="fotoGrid"></div></div>
    <div class="section">
      <h3>Revisión</h3>
      <textarea id="adminNota" maxlength="1000" placeholder="Nota opcional (ej. motivo de rechazo)"></textarea>
      <div class="actions-row">
        <button class="btn primary" id="btnAprobar" type="button">Aprobar</button>
        <button class="btn danger" id="btnRechazar" type="button">Rechazar</button>
      </div>
      <div class="actions-row">
        <button class="btn" id="btnExportZip" type="button" ${lote.status === 'aprobado' ? '' : 'disabled'}>Exportar ZIP (originales)</button>
      </div>
      <div class="status-line" id="revisionLine">${lote.revisadoAt && lote.revisadoAt.toDate ? 'Última revisión: ' + esc(fmtFecha(lote.revisadoAt)) : ''}</div>
    </div>`;

  $('adminNota').value = notaEnEdicion ?? (typeof lote.adminNota === 'string' ? lote.adminNota : '');

  const grid = $('fotoGrid');
  for (const foto of fotos) {
    const url = urlFotoSegura(foto.url);
    const fig = document.createElement('figure');
    if (url) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = urlMiniatura(url);
      img.alt = 'Foto ' + (num(foto.order) ?? '');
      img.loading = 'lazy';
      a.appendChild(img);
      fig.appendChild(a);
    } else {
      const warn = document.createElement('div');
      warn.className = 'no-data'; warn.style.padding = '8px';
      warn.textContent = 'URL de foto inválida (no es de nuestra cuenta)';
      fig.appendChild(warn);
    }
    const cap = document.createElement('figcaption');
    const partes = ['#' + (num(foto.order) ?? '?')];
    if (num(foto.capturedAt)) partes.push(new Date(foto.capturedAt).toLocaleTimeString('es-PY'));
    if (num(foto.width) && num(foto.height)) partes.push(`${foto.width}×${foto.height}`);
    cap.textContent = partes.join(' · ');
    fig.appendChild(cap);
    grid.appendChild(fig);
  }

  $('btnAprobar').addEventListener('click', () => actualizarEstado(loteId, 'aprobado'));
  $('btnRechazar').addEventListener('click', () => actualizarEstado(loteId, 'rechazado'));
  $('btnExportZip').addEventListener('click', () => exportarZip(lote, fotos));
}

async function actualizarEstado(loteId, status) {
  const nota = $('adminNota').value.trim().slice(0, 1000);
  try {
    await updateDoc(doc(db, 'lotes', loteId), {
      status,
      adminNota: nota || null,
      revisadoPor: auth.currentUser.uid,
      revisadoAt: serverTimestamp()
    });
  } catch (e) {
    alert('No se pudo guardar la revisión (permisos o conexión).');
  }
}

/* Exportar ZIP (originales en máxima calidad) --------------------------- */

const nombreSeguro = (s) => String(s || 'lote').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);

async function exportarZip(lote, fotos) {
  const btn = $('btnExportZip');
  const originalText = btn.textContent;
  btn.disabled = true;
  try {
    const zip = new JSZip();
    const ticket = nombreSeguro(lote.ticketCode);
    let i = 0;
    for (const foto of fotos) {
      const url = urlFotoSegura(foto.url);
      if (!url) continue;
      btn.textContent = `Descargando ${++i}/${fotos.length}…`;
      const resp = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!resp.ok) throw new Error('No se pudo descargar la foto ' + foto.order);
      zip.file(`${ticket}_${String(num(foto.order) || i).padStart(2, '0')}.jpg`, await resp.blob(), { compression: 'STORE' });
    }
    const metadata = {
      ticketCode: lote.ticketCode,
      agente: lote.agente || null,
      patente: lote.patente || null,
      ubicacion: lote.ubicacion || null,
      status: lote.status,
      adminNota: lote.adminNota || null,
      fotos: fotos.map(f => ({
        orden: f.order, url: urlFotoSegura(f.url), ancho: f.width || null, alto: f.height || null,
        bytes: f.bytes || null, fuente: f.fuente || null,
        capturedAt: num(f.capturedAt) ? new Date(f.capturedAt).toISOString() : null
      }))
    };
    zip.file('metadata.json', JSON.stringify(metadata, null, 2));
    btn.textContent = 'Generando ZIP…';
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url; a.download = `${ticket}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    alert('Error al generar el ZIP: ' + (e && e.message ? e.message : String(e)));
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/* Escáner QR ------------------------------------------------------------ */

const qrModal = $('qrModal');
const qrVideo = $('qrVideo');
const qrResult = $('qrResult');
const qrScanCanvas = document.createElement('canvas');
let qrStream = null;
let qrScanning = false;

async function abrirEscaner() {
  qrResult.replaceChildren();
  qrModal.classList.add('open');
  try {
    qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    qrVideo.srcObject = qrStream;
    qrScanning = true;
    requestAnimationFrame(tickEscaner);
  } catch (e) {
    qrResult.innerHTML = '<p class="error-msg" style="color:var(--red);">No se pudo acceder a la cámara.</p>';
  }
}

function cerrarEscaner() {
  qrScanning = false;
  if (qrStream) { qrStream.getTracks().forEach(t => t.stop()); qrStream = null; }
  qrModal.classList.remove('open');
}

function tickEscaner() {
  if (!qrScanning) return;
  if (qrVideo.readyState === qrVideo.HAVE_ENOUGH_DATA) {
    qrScanCanvas.width = qrVideo.videoWidth;
    qrScanCanvas.height = qrVideo.videoHeight;
    const ctx = qrScanCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(qrVideo, 0, 0, qrScanCanvas.width, qrScanCanvas.height);
    const imageData = ctx.getImageData(0, 0, qrScanCanvas.width, qrScanCanvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    if (code && code.data) {
      qrScanning = false;
      verificarCodigo(String(code.data).trim().slice(0, 64));
      return;
    }
  }
  requestAnimationFrame(tickEscaner);
}

async function verificarCodigo(texto) {
  qrResult.innerHTML = '<p><span class="spinner"></span> Verificando…</p>';
  const m = QR_RE.exec(texto);
  if (!m || !TICKET_RE.test(m[1])) {
    mostrarResultadoInvalido(`Código no reconocido: "${texto}"`);
    return;
  }
  const [, ticketCode, fotoId] = m;
  try {
    const snap = await getDocs(query(collection(db, 'lotes'), where('ticketCode', '==', ticketCode), limit(2)));
    if (snap.empty) {
      mostrarResultadoInvalido(`El ticket "${ticketCode}" no existe en la base. Podría ser un código falso.`);
      return;
    }
    const loteDoc = snap.docs[0];
    const lote = loteDoc.data();
    const fotoSnap = await getDoc(doc(db, 'lotes', loteDoc.id, 'fotos', fotoId));
    if (!fotoSnap.exists()) {
      mostrarResultadoInvalido(`La foto ${fotoId} no existe dentro del ticket "${ticketCode}".`);
      return;
    }
    const foto = fotoSnap.data();
    const url = urlFotoSegura(foto.url);
    const ubic = lote.ubicacion || {};
    const lat = num(ubic.lat), lng = num(ubic.lng);
    qrResult.innerHTML = `
      <div class="card" style="text-align:left;">
        <div style="display:flex; gap:10px; align-items:flex-start;">
          ${url ? `<img src="${esc(urlMiniatura(url))}" alt="" style="width:80px; height:80px; object-fit:cover; border-radius:4px; border:1px solid var(--border); flex-shrink:0;">` : ''}
          <div>
            <span class="badge green">✓ Coincide con la base de datos</span>
            <div style="margin-top:4px;"><strong>${esc(ticketCode)}</strong> · foto ${esc(fotoId)}</div>
            <div style="margin-top:2px;">${statusBadge(lote.status)}</div>
            ${snap.size > 1 ? '<div class="badge orange" style="margin-top:4px;">⚠ Hay más de un lote con este ticket</div>' : ''}
          </div>
        </div>
        <table class="kv" style="margin-top:10px;">
          <tr><td>Agente / broker</td><td>${esc(lote.agente || '—')}</td></tr>
          <tr><td>Patente</td><td>${esc(lote.patente || '—')}</td></tr>
          <tr><td>Fecha/hora real de esta foto</td><td>${num(foto.capturedAt) ? esc(new Date(foto.capturedAt).toLocaleString('es-PY')) : '—'}</td></tr>
          <tr><td>Ubicación real del lote</td><td>${lat !== null && lng !== null ? esc(lat.toFixed(6) + ', ' + lng.toFixed(6)) : '—'}</td></tr>
        </table>
        <div class="btn-row">
          <button class="link-btn" id="qrVerLote" type="button">Ver lote completo</button>
          <button class="link-btn" id="qrEscanearOtro" type="button">Escanear otro</button>
        </div>
      </div>`;
    $('qrVerLote').addEventListener('click', () => {
      cerrarEscaner();
      state.selectedLoteId = loteDoc.id;
      renderList();
      renderDetail(loteDoc.id);
      $('detailPanel').classList.add('open');
    });
    $('qrEscanearOtro').addEventListener('click', reanudarEscaneo);
  } catch (e) {
    qrResult.innerHTML = '<p class="error-msg" style="color:var(--red);">Error al verificar (permisos o conexión).</p>';
  }
}

function mostrarResultadoInvalido(mensaje) {
  qrResult.innerHTML = `
    <div class="card" style="text-align:left;">
      <span class="badge red">✕ No verificado</span>
      <p style="margin:8px 0 0; font-size:12.5px;">${esc(mensaje)}</p>
      <div class="btn-row"><button class="link-btn" id="qrEscanearOtro" type="button">Escanear otro</button></div>
    </div>`;
  $('qrEscanearOtro').addEventListener('click', reanudarEscaneo);
}

function reanudarEscaneo() {
  qrResult.replaceChildren();
  qrScanning = true;
  requestAnimationFrame(tickEscaner);
}

$('btnEscanearQr').addEventListener('click', abrirEscaner);
$('btnCerrarQr').addEventListener('click', cerrarEscaner);
$('closeDetailBtn').addEventListener('click', () => $('detailPanel').classList.remove('open'));
