// Panel admin web. Todos los datos viven en la cuenta de Google propia y se
// piden al Apps Script con una sesión de admin (usuario + contraseña creados
// desde la Planilla: "Validador > Crear o cambiar usuario admin").
//
// Seguridad (OWASP):
//  - A03 XSS: todo dato de un lote (lo escribió un broker) o de un QR se pinta
//    con textContent / esc(). Las fotos llegan como base64 y se muestran como
//    data:/blob: (nunca URLs que vengan de los datos).
//  - A07: la sesión vive solo en esta pestaña (sessionStorage), el servidor la
//    vence a los 30 min sin uso y acá se cierra también por inactividad.
//  - Sin scripts inline (CSP estricta en admin.html).
import { APPS_SCRIPT_URL } from './config.js';

if (window.top !== window.self) {
  document.documentElement.style.display = 'none';
  throw new Error('Esta página no puede mostrarse dentro de un frame.');
}

const $ = (id) => document.getElementById(id);
const INACTIVIDAD_MS = 30 * 60 * 1000;
const CLAVE_SESION = 'validador_admin_sesion';

const state = { lotes: [], selected: null, statusFilter: 'todos', search: '', usuario: '' };

/* Helpers --------------------------------------------------------------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const fmt = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleString('es-PY') : '—'; };
const nn = (n) => String(n).padStart(2, '0');
const TICKET_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const B64_RE = /^[A-Za-z0-9+/=]+$/;
const dataJpeg = (b64) => (typeof b64 === 'string' && B64_RE.test(b64) ? 'data:image/jpeg;base64,' + b64 : null);

function sesionGuardada() { try { return sessionStorage.getItem(CLAVE_SESION) || ''; } catch (_) { return ''; } }
function guardarSesion(t) { try { t ? sessionStorage.setItem(CLAVE_SESION, t) : sessionStorage.removeItem(CLAVE_SESION); } catch (_) { /* sin storage */ } }

// POST como text/plain (pedido simple, sin preflight CORS que Apps Script no soporta).
function api(cuerpo) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', APPS_SCRIPT_URL);
    xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
    xhr.timeout = 180000;
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* abajo */ }
      if (xhr.status !== 200 || !data) return reject(new Error('conexion'));
      if (!data.ok) {
        if (data.error === 'sesion_invalida') { cerrarSesionLocal('Tu sesión venció. Volvé a ingresar.'); }
        return reject(new Error(String(data.error || 'error')));
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error('conexion'));
    xhr.ontimeout = () => reject(new Error('conexion'));
    xhr.send(JSON.stringify(cuerpo));
  });
}
const apiAdmin = (accion, datos = {}) => api({ accion, sesion: sesionGuardada(), ...datos });

const MENSAJES = {
  credenciales_invalidas: 'Usuario o contraseña incorrectos.',
  bloqueado: 'Demasiados intentos fallidos. Esperá 15 minutos.',
  conexion: 'No hay conexión con el servidor. Revisá internet.',
  no_encontrado: 'No se encontró.',
  sesion_invalida: 'Tu sesión venció.'
};
const msg = (e) => MENSAJES[e && e.message] || 'Ocurrió un error (' + esc(e && e.message) + ').';

/* Login / sesión -------------------------------------------------------- */

function mostrar(vista) {
  $('loginWrap').classList.toggle('hidden', vista !== 'login');
  $('noAuthWrap').classList.add('hidden');
  $('dashboard').classList.toggle('hidden', vista !== 'panel');
}

async function login() {
  const usuario = $('userInput').value.trim();
  const clave = $('passInput').value;
  const errEl = $('loginError');
  errEl.textContent = '';
  if (!usuario || !clave) { errEl.textContent = 'Completá usuario y contraseña.'; return; }
  $('btnLogin').disabled = true;
  $('btnLogin').textContent = 'Ingresando…';
  try {
    const r = await api({ accion: 'adminLogin', usuario, clave });
    guardarSesion(r.sesion);
    state.usuario = r.usuario;
    $('passInput').value = '';
    entrar();
  } catch (e) {
    errEl.textContent = msg(e);
  } finally {
    $('btnLogin').disabled = false;
    $('btnLogin').textContent = 'Ingresar';
  }
}

function entrar() {
  mostrar('panel');
  reiniciarInactividad();
  cargarLotes();
}

function cerrarSesionLocal(aviso) {
  guardarSesion('');
  state.lotes = []; state.selected = null;
  clearTimeout(idleTimer);
  cerrarEscaner();
  $('fotoModal').classList.remove('open');
  $('detailContent').innerHTML = '<div class="detail__empty">Seleccioná un lote de la lista para ver su detalle.</div>';
  $('loginError').textContent = aviso || '';
  mostrar('login');
}

async function logout() {
  const s = sesionGuardada();
  cerrarSesionLocal('');
  if (s) api({ accion: 'adminLogout', sesion: s }).catch(() => {});
}

$('btnLogin').addEventListener('click', login);
$('passInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('userInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('passInput').focus(); });
$('btnLogout').addEventListener('click', logout);
$('btnLogoutNoAuth').addEventListener('click', logout);

let idleTimer = null;
function reiniciarInactividad() {
  clearTimeout(idleTimer);
  if (sesionGuardada()) idleTimer = setTimeout(() => logout(), INACTIVIDAD_MS);
}
['pointerdown', 'keydown', 'scroll'].forEach((ev) => window.addEventListener(ev, reiniciarInactividad, { passive: true }));

/* Lista de lotes -------------------------------------------------------- */

async function cargarLotes() {
  const empty = $('emptyState');
  if (!state.lotes.length) { empty.textContent = 'Cargando lotes…'; empty.style.display = ''; }
  try {
    const r = await apiAdmin('adminLotes');
    state.lotes = Array.isArray(r.lotes) ? r.lotes : [];
    renderList();
  } catch (e) {
    if (e.message !== 'sesion_invalida') { empty.textContent = msg(e); empty.style.display = ''; }
  }
}

function matchesFilters(l) {
  if (state.statusFilter !== 'todos' && l.estado !== state.statusFilter) return false;
  if (state.search) {
    const s = state.search.toLowerCase();
    return [l.ticket, l.patente, l.agente].some(v => String(v || '').toLowerCase().includes(s));
  }
  return true;
}

function statusBadge(estado) {
  if (estado === 'aprobado') return '<span class="badge green">🟢 Aprobado</span>';
  if (estado === 'rechazado') return '<span class="badge red">🔴 Rechazado</span>';
  return '<span class="badge yellow">🟡 Pendiente</span>';
}

function renderList() {
  const list = $('list');
  const empty = $('emptyState');
  list.querySelectorAll('.row').forEach(r => r.remove());
  const visibles = state.lotes.filter(matchesFilters);
  if (!visibles.length) {
    empty.textContent = state.lotes.length ? 'Ningún lote coincide con el filtro/búsqueda.' : 'Todavía no hay lotes cargados.';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  for (const l of visibles) {
    if (!TICKET_RE.test(String(l.ticket))) continue;
    const row = document.createElement('div');
    row.className = 'row' + (l.ticket === state.selected ? ' selected' : '');
    row.tabIndex = 0;
    const fotos = num(l.fotosRecibidas) ?? 0;
    const decl = num(l.fotosDeclaradas);
    const faltan = decl !== null && fotos < decl ? ` <span class="badge orange">faltan ${esc(decl - fotos)}</span>` : '';
    row.innerHTML = `
      <div class="row__top">
        <span class="row__ticket">${esc(l.ticket)}</span>
        <span>${statusBadge(l.estado)}${faltan}</span>
      </div>
      <div class="row__sub">${esc(l.agente || 'sin agente')} · ${esc(l.patente || 'sin patente')} · ${esc(fotos)} fotos · ${esc(fmt(l.creado))}</div>`;
    const abrir = () => {
      state.selected = l.ticket;
      renderList();
      renderDetail(l.ticket);
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
$('btnActualizar').addEventListener('click', cargarLotes);
// Refresco automático cada 60 s mientras la pestaña está visible.
setInterval(() => { if (sesionGuardada() && document.visibilityState === 'visible') cargarLotes(); }, 60000);

/* Detalle --------------------------------------------------------------- */

async function renderDetail(ticket) {
  const content = $('detailContent');
  content.innerHTML = '<div class="detail__empty"><span class="spinner"></span> Cargando lote…</div>';
  let lote;
  try { lote = (await apiAdmin('adminLote', { ticket })).lote; }
  catch (e) { if (state.selected === ticket) content.innerHTML = `<div class="detail__empty">${msg(e)}</div>`; return; }
  if (state.selected !== ticket) return;

  const lat = num(lote.lat), lng = num(lote.lng), acc = num(lote.precisionM);
  const fotos = Array.isArray(lote.fotos) ? lote.fotos : [];
  const totalBytes = fotos.reduce((s, f) => s + (num(f.bytes) || 0), 0);
  const decl = num(lote.fotosDeclaradas);

  content.innerHTML = `
    <div class="detail__title">${esc(lote.ticket)}</div>
    <div>${statusBadge(lote.estado)}</div>
    ${decl !== null && fotos.length < decl ? `<p class="badge orange" style="margin-top:6px;">⚠ El celular declaró ${esc(decl)} fotos y llegaron ${esc(fotos.length)}</p>` : ''}
    <div class="section">
      <h3>Datos del lote</h3>
      <table class="kv">
        <tr><td>Agente / broker</td><td>${esc(lote.agente || '—')}</td></tr>
        <tr><td>Patente</td><td>${esc(lote.patente || '—')}</td></tr>
        <tr><td>Creado (hora del servidor)</td><td>${esc(fmt(lote.creado))}</td></tr>
        <tr><td>Fotos</td><td>${esc(fotos.length)}${totalBytes ? ' · ' + esc((totalBytes / 1048576).toFixed(1)) + ' MB' : ''}</td></tr>
        <tr><td>Navegador</td><td style="font-size:10.5px;">${esc(lote.userAgent || '—')}</td></tr>
      </table>
    </div>
    <div class="section">
      <h3>Ubicación</h3>
      ${lat !== null && lng !== null ? `
        <table class="kv">
          <tr><td>Coordenadas</td><td>${esc(lat.toFixed(6))}, ${esc(lng.toFixed(6))}</td></tr>
          <tr><td>Precisión</td><td>${acc !== null ? '±' + esc(Math.round(acc)) + ' m' : '—'}</td></tr>
          <tr><td>GPS tomado</td><td>${esc(fmt(lote.gpsCapturado))}</td></tr>
        </table>
        <div class="btn-row" style="margin-top:6px;"><a class="link-btn" href="https://www.google.com/maps?q=${encodeURIComponent(lat + ',' + lng)}" target="_blank" rel="noopener noreferrer">Ver en el mapa</a></div>`
        : '<p class="no-data">Sin datos de ubicación.</p>'}
    </div>
    <div class="section">
      <h3>Fotos <span style="text-transform:none; font-weight:400; color:var(--text-faint);">(click para ver el original)</span></h3>
      <div class="foto-grid" id="fotoGrid"></div>
    </div>
    <div class="section">
      <h3>Revisión</h3>
      <textarea id="adminNota" maxlength="1000" placeholder="Nota opcional (ej. motivo de rechazo)"></textarea>
      <div class="actions-row">
        <button class="btn primary" id="btnAprobar" type="button">Aprobar</button>
        <button class="btn danger" id="btnRechazar" type="button">Rechazar</button>
      </div>
      <div class="actions-row">
        <button class="btn" id="btnExportZip" type="button" ${fotos.length ? '' : 'disabled'}>Descargar todo (ZIP de originales)</button>
      </div>
      <div class="status-line" id="revisionLine">${lote.revisadoAt ? 'Última revisión: ' + esc(fmt(lote.revisadoAt)) + ' · ' + esc(lote.revisadoPor || '') : ''}</div>
    </div>`;

  $('adminNota').value = typeof lote.nota === 'string' ? lote.nota : '';

  const grid = $('fotoGrid');
  const celdas = {};
  for (const f of fotos) {
    const nro = num(f.nro);
    if (nro === null) continue;
    const fig = document.createElement('figure');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'foto-btn';
    btn.setAttribute('aria-label', 'Ver original de la foto ' + nro);
    const ph = document.createElement('div'); ph.className = 'sin-mini'; ph.textContent = 'cargando…';
    btn.appendChild(ph);
    btn.addEventListener('click', () => verOriginal(lote.ticket, nro));
    fig.appendChild(btn);
    const cap = document.createElement('figcaption');
    const partes = ['#' + nro];
    if (num(f.ancho) && num(f.alto)) partes.push(`${f.ancho}×${f.alto}`);
    if (num(f.bytes)) partes.push((f.bytes / 1048576).toFixed(1) + ' MB');
    cap.textContent = partes.join(' · ');
    cap.title = 'Sacada: ' + fmt(f.capturadaCelular) + ' · Recibida: ' + fmt(f.recibida) + ' · SHA-256: ' + String(f.sha256 || '');
    fig.appendChild(cap);
    grid.appendChild(fig);
    celdas[nro] = btn;
  }

  $('btnAprobar').addEventListener('click', () => revisar(lote.ticket, 'aprobado'));
  $('btnRechazar').addEventListener('click', () => revisar(lote.ticket, 'rechazado'));
  $('btnExportZip').addEventListener('click', () => exportarZip(lote, fotos));

  // Miniaturas (todas en un solo pedido).
  try {
    const r = await apiAdmin('adminMinis', { ticket: lote.ticket });
    if (state.selected !== ticket) return;
    for (const [nro, b64] of Object.entries(r.minis || {})) {
      const btn = celdas[Number(nro)];
      if (!btn) continue;
      const src = dataJpeg(b64);
      if (src) {
        const img = document.createElement('img');
        img.src = src; img.alt = 'Foto ' + nro;
        btn.replaceChildren(img);
      } else {
        btn.firstChild.textContent = 'sin miniatura — click para ver';
      }
    }
  } catch (_) {
    Object.values(celdas).forEach(b => { if (b.firstChild) b.firstChild.textContent = 'click para ver'; });
  }
}

async function revisar(ticket, estado) {
  const nota = $('adminNota').value.trim().slice(0, 1000);
  const linea = $('revisionLine');
  linea.textContent = 'Guardando…';
  try {
    const r = await apiAdmin('adminRevisar', { ticket, estado, nota });
    const i = state.lotes.findIndex(l => l.ticket === ticket);
    if (i >= 0 && r.lote) state.lotes[i] = r.lote;
    renderList();
    renderDetail(ticket);
  } catch (e) {
    linea.textContent = msg(e);
  }
}

/* Foto original --------------------------------------------------------- */

let urlOriginal = null;
function b64ABlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

async function bajarOriginal(ticket, nro) {
  const r = await apiAdmin('adminOriginal', { ticket, nro });
  if (typeof r.data !== 'string' || !B64_RE.test(r.data)) throw new Error('respuesta_invalida');
  return b64ABlob(r.data);
}

async function verOriginal(ticket, nro) {
  const modal = $('fotoModal');
  const cuerpo = $('fotoModalCuerpo');
  const desc = $('fotoModalDescargar');
  $('fotoModalTitulo').textContent = `${ticket}-${nn(nro)} · original`;
  desc.classList.add('hidden');
  cuerpo.innerHTML = '<p><span class="spinner"></span> Descargando la foto en máxima calidad…</p>';
  modal.classList.add('open');
  try {
    const blob = await bajarOriginal(ticket, nro);
    if (urlOriginal) URL.revokeObjectURL(urlOriginal);
    urlOriginal = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.src = urlOriginal; img.alt = 'Original';
    img.addEventListener('load', () => {
      $('fotoModalTitulo').textContent = `${ticket}-${nn(nro)} · ${img.naturalWidth}×${img.naturalHeight} · ${(blob.size / 1048576).toFixed(1)} MB`;
    });
    cuerpo.replaceChildren(img);
    desc.href = urlOriginal;
    desc.download = `${ticket}-${nn(nro)}.jpg`;
    desc.classList.remove('hidden');
  } catch (e) {
    cuerpo.innerHTML = `<p class="error-msg" style="color:var(--red);">${msg(e)}</p>`;
  }
}

function cerrarFoto() {
  $('fotoModal').classList.remove('open');
  $('fotoModalCuerpo').replaceChildren();
  if (urlOriginal) { URL.revokeObjectURL(urlOriginal); urlOriginal = null; }
}
$('btnCerrarFoto').addEventListener('click', cerrarFoto);
$('fotoModal').addEventListener('click', (e) => { if (e.target === $('fotoModal')) cerrarFoto(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { cerrarFoto(); cerrarEscaner(); } });

/* Exportar ZIP ---------------------------------------------------------- */

async function exportarZip(lote, fotos) {
  const btn = $('btnExportZip');
  const original = btn.textContent;
  btn.disabled = true;
  try {
    const zip = new JSZip();
    let i = 0;
    for (const f of fotos) {
      const nro = num(f.nro);
      if (nro === null) continue;
      btn.textContent = `Descargando ${++i}/${fotos.length}…`;
      zip.file(`${lote.ticket}-${nn(nro)}.jpg`, await bajarOriginal(lote.ticket, nro), { compression: 'STORE' });
    }
    const meta = { ...lote };
    zip.file('metadata.json', JSON.stringify(meta, null, 2));
    btn.textContent = 'Generando ZIP…';
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url; a.download = `${lote.ticket}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    alert('No se pudo generar el ZIP: ' + (MENSAJES[e && e.message] || (e && e.message)));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* Escáner QR ------------------------------------------------------------ */

const qrModal = $('qrModal');
const qrVideo = $('qrVideo');
const qrResult = $('qrResult');
const qrCanvas = document.createElement('canvas');
let qrStream = null;
let qrScanning = false;

async function abrirEscaner() {
  qrResult.replaceChildren();
  qrModal.classList.add('open');
  try {
    qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    qrVideo.srcObject = qrStream;
    qrScanning = true;
    requestAnimationFrame(tick);
  } catch (_) {
    qrResult.innerHTML = '<p class="error-msg" style="color:var(--red);">No se pudo acceder a la cámara.</p>';
  }
}

function cerrarEscaner() {
  qrScanning = false;
  if (qrStream) { qrStream.getTracks().forEach(t => t.stop()); qrStream = null; }
  qrModal.classList.remove('open');
}

function tick() {
  if (!qrScanning) return;
  if (qrVideo.readyState === qrVideo.HAVE_ENOUGH_DATA) {
    qrCanvas.width = qrVideo.videoWidth;
    qrCanvas.height = qrVideo.videoHeight;
    const ctx = qrCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(qrVideo, 0, 0, qrCanvas.width, qrCanvas.height);
    const img = ctx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
    const code = jsQR(img.data, img.width, img.height);
    if (code && code.data) {
      qrScanning = false;
      verificar(String(code.data).trim().slice(0, 64));
      return;
    }
  }
  requestAnimationFrame(tick);
}

async function verificar(texto) {
  qrResult.innerHTML = '<p><span class="spinner"></span> Verificando…</p>';
  try {
    const r = await apiAdmin('adminVerificar', { codigo: texto });
    if (!r.valido) {
      const motivos = {
        formato: `Código no reconocido: "${texto}". No es un QR del validador.`,
        ticket: `El ticket del código "${texto}" no existe. Podría ser un QR falso.`,
        foto: `El ticket existe, pero esa foto no está registrada ("${texto}").`
      };
      return resultado(false, motivos[r.motivo] || 'No verificado.', r.lote);
    }
    resultado(true, '', r.lote, r.foto, r.mini);
  } catch (e) {
    if (e.message !== 'sesion_invalida') qrResult.innerHTML = `<p class="error-msg" style="color:var(--red);">${msg(e)}</p>`;
  }
}

function resultado(valido, mensaje, lote, foto, mini) {
  const src = dataJpeg(mini);
  qrResult.innerHTML = `
    <div class="card" style="text-align:left;">
      <div style="display:flex; gap:10px; align-items:flex-start;">
        ${src ? `<img src="${src}" alt="" style="width:80px; height:80px; object-fit:cover; border-radius:4px; border:1px solid var(--border); flex-shrink:0;">` : ''}
        <div>
          ${valido ? '<span class="badge green">✓ Coincide con la base de datos</span>' : '<span class="badge red">✕ No verificado</span>'}
          ${lote ? `<div style="margin-top:4px;"><strong>${esc(lote.ticket)}</strong>${foto ? ' · foto ' + esc(nn(foto.nro)) : ''}</div><div style="margin-top:2px;">${statusBadge(lote.estado)}</div>` : ''}
        </div>
      </div>
      ${mensaje ? `<p style="margin:8px 0 0; font-size:12.5px;">${esc(mensaje)}</p>` : ''}
      ${lote ? `
      <table class="kv" style="margin-top:10px;">
        <tr><td>Agente / broker</td><td>${esc(lote.agente || '—')}</td></tr>
        <tr><td>Patente</td><td>${esc(lote.patente || '—')}</td></tr>
        ${foto ? `<tr><td>Foto sacada (celular)</td><td>${esc(fmt(foto.capturadaCelular))}</td></tr>
        <tr><td>Foto recibida (servidor)</td><td>${esc(fmt(foto.recibida))}</td></tr>` : ''}
        <tr><td>Ubicación del lote</td><td>${num(lote.lat) !== null ? esc(num(lote.lat).toFixed(6) + ', ' + num(lote.lng).toFixed(6)) : '—'}</td></tr>
      </table>` : ''}
      <div class="btn-row">
        ${lote ? '<button class="link-btn" id="qrVerLote" type="button">Ver lote completo</button>' : ''}
        <button class="link-btn" id="qrOtro" type="button">Escanear otro</button>
      </div>
    </div>`;
  if (lote) {
    $('qrVerLote').addEventListener('click', () => {
      cerrarEscaner();
      state.selected = lote.ticket;
      renderList();
      renderDetail(lote.ticket);
      $('detailPanel').classList.add('open');
    });
  }
  $('qrOtro').addEventListener('click', () => { qrResult.replaceChildren(); qrScanning = true; requestAnimationFrame(tick); });
}

$('btnEscanearQr').addEventListener('click', abrirEscaner);
$('btnCerrarQr').addEventListener('click', cerrarEscaner);
$('closeDetailBtn').addEventListener('click', () => $('detailPanel').classList.remove('open'));

/* Arranque -------------------------------------------------------------- */

if (sesionGuardada()) entrar(); else mostrar('login');
