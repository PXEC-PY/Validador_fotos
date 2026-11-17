// Flujo del broker/agente: datos -> GPS -> cámara -> subida -> ticket.
//
// Seguridad (OWASP):
//  - Sin scripts inline: la CSP de index.html no necesita 'unsafe-inline'.
//  - Todo texto se pinta con textContent (nada de innerHTML con datos).
//  - Entradas normalizadas y limitadas aquí Y validadas otra vez en
//    firestore.rules (el cliente nunca es la única barrera).
//  - Ticket generado con crypto.getRandomValues (no Math.random).
import {
  auth, db, MAX_FOTOS, CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET,
  CLOUDINARY_URL_PREFIX, FOTO_MAX_LADO, FOTO_CALIDAD_JPEG, FOTO_MAX_BYTES
} from './firebase-config.js';
import { signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { collection, doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// Anti-clickjacking (GitHub Pages no permite enviar X-Frame-Options).
if (window.top !== window.self) {
  document.documentElement.style.display = 'none';
  throw new Error('Esta página no puede mostrarse dentro de un frame.');
}

const $ = (id) => document.getElementById(id);
const MAX_DISPAROS = 99; // el ID de cada foto en Firestore es de 2 dígitos

$('maxFotosLabel').textContent = String(MAX_FOTOS);
$('fotoCounter').textContent = `0 / ${MAX_FOTOS}`;

const state = {
  agente: '',
  patente: '',
  ubicacion: null,   // { lat, lng, accuracy, capturedAt }
  fotos: [],         // [{ blob, objectUrl, capturedAt, shotNumber, width, height, fuente }]
  nextShotNumber: 1,
  stream: null,
  imageCapture: null,
  loteId: null,
  loteCreado: false,
  subidas: new Set(), // shotNumbers ya guardados (para reintentar sin duplicar)
  ticketCode: null,
  subiendo: false
};

const screens = ['screenInicio', 'screenUbicacion', 'screenCamara', 'screenSubiendo', 'screenTicket'];
const stepLabels = { screenInicio: 'paso 1 / 4', screenUbicacion: 'paso 2 / 4', screenCamara: 'paso 3 / 4', screenSubiendo: 'subiendo…', screenTicket: 'listo' };

function showScreen(id) {
  for (const s of screens) $(s).classList.toggle('active', s === id);
  $('stepBadge').textContent = stepLabels[id] || '';
}

const nn = (n) => String(n).padStart(2, '0');
const limpiarTexto = (s) => s.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();

/* 1. Inicio ------------------------------------------------------------- */

$('btnComenzar').addEventListener('click', () => {
  const agente = limpiarTexto($('agenteInput').value).slice(0, 80);
  const patente = $('patenteInput').value.toUpperCase().replace(/[^A-Z0-9 -]/g, '').trim().slice(0, 12);
  if (agente.length < 2) {
    $('inicioError').textContent = 'Indicá el nombre del agente o broker que envía las fotos.';
    $('agenteInput').focus();
    return;
  }
  $('inicioError').textContent = '';
  state.agente = agente;
  state.patente = patente;
  showScreen('screenUbicacion');
  solicitarUbicacion();
});

/* 2. Ubicación ---------------------------------------------------------- */

function renderUbicEstado(tone, construir) {
  const box = $('ubicEstado');
  box.replaceChildren();
  const div = document.createElement('div');
  div.className = 'card status-box' + (tone ? ' ' + tone : '');
  construir(div);
  box.appendChild(div);
}
const textoUbic = (tone, msg) => renderUbicEstado(tone, (d) => { d.textContent = msg; });

function calificarPrecision(accuracy) {
  if (accuracy <= 50) return { tone: 'ok', texto: 'Precisión buena' };
  if (accuracy <= 150) return { tone: 'warn', texto: 'Precisión moderada — si podés, reintentá al aire libre' };
  return { tone: 'bad', texto: 'Precisión baja — te recomendamos reintentar' };
}

function solicitarUbicacion() {
  $('btnConfirmarUbic').disabled = true;
  renderUbicEstado(null, (d) => {
    const sp = document.createElement('span'); sp.className = 'spinner';
    d.append(sp, ' Obteniendo tu ubicación…');
  });

  if (!('geolocation' in navigator)) {
    textoUbic('bad', 'Este navegador no soporta geolocalización. Probá desde otro dispositivo o navegador.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      state.ubicacion = { lat: latitude, lng: longitude, accuracy, capturedAt: Date.now() };
      const cal = calificarPrecision(accuracy);
      renderUbicEstado(cal.tone, (d) => {
        const w = document.createElement('div');
        const t = document.createElement('div'); t.innerHTML = '<strong>Ubicación detectada</strong>';
        const c = document.createElement('div'); c.className = 'mono'; c.style.cssText = 'font-size:12.5px; margin-top:4px;';
        c.textContent = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
        const p = document.createElement('div'); p.className = 'ubic-precision';
        p.textContent = `${cal.texto} (±${Math.round(accuracy)} m)`;
        const row = document.createElement('div'); row.className = 'btn-row'; row.style.marginTop = '8px';
        const a = document.createElement('a'); a.className = 'link-btn'; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.href = `https://www.google.com/maps?q=${latitude},${longitude}`; a.textContent = 'Ver en el mapa';
        row.appendChild(a);
        w.append(t, c, p, row);
        d.appendChild(w);
      });
      $('btnConfirmarUbic').disabled = false;
    },
    (err) => {
      let msg = 'No pudimos obtener tu ubicación.';
      if (err.code === err.PERMISSION_DENIED) msg = 'Denegaste el permiso de ubicación. Activalo en la configuración del navegador para continuar.';
      else if (err.code === err.TIMEOUT) msg = 'Se agotó el tiempo esperando el GPS. Probá de nuevo, preferentemente al aire libre.';
      textoUbic('bad', msg);
      state.ubicacion = null;
      $('btnConfirmarUbic').disabled = true;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

$('btnReintentarUbic').addEventListener('click', solicitarUbicacion);
$('btnConfirmarUbic').addEventListener('click', () => {
  if (!state.ubicacion) return;
  if (!state.ticketCode) state.ticketCode = generarTicketCode();
  $('ticketPreview').textContent = 'Ticket: ' + state.ticketCode;
  showScreen('screenCamara');
  iniciarCamara();
});

/* 3. Cámara (máxima calidad) -------------------------------------------- */

const video = $('video');
const camaraError = $('camaraError');
const btnDisparar = $('btnDisparar');

async function iniciarCamara() {
  camaraError.textContent = '';
  try {
    // Pedimos la resolución más alta que tenga la cámara trasera: con
    // "ideal" el navegador entrega lo máximo que soporte sin fallar.
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 4096 },
        height: { ideal: 4096 }
      },
      audio: false
    });
    video.srcObject = state.stream;
    const track = state.stream.getVideoTracks()[0];
    // ImageCapture (Chrome/Android) saca una FOTO real con el sensor completo
    // (ej. 12 MP), no un cuadro del video. En iPhone no existe: se usa el
    // cuadro del video a la resolución máxima que entregó la cámara.
    state.imageCapture = ('ImageCapture' in window && track) ? new window.ImageCapture(track) : null;
    btnDisparar.disabled = false;
  } catch (e) {
    camaraError.textContent = 'No pudimos acceder a la cámara. Revisá los permisos del navegador e intentá de nuevo.';
    btnDisparar.disabled = true;
  }
}

function renderThumbs() {
  const strip = $('thumbStrip');
  strip.replaceChildren();
  state.fotos.forEach((foto, idx) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.title = `${foto.width}×${foto.height} · ${(foto.blob.size / 1048576).toFixed(1)} MB`;
    const img = document.createElement('img');
    img.src = foto.objectUrl;
    img.alt = 'Foto ' + foto.shotNumber;
    div.appendChild(img);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Borrar foto');
    del.addEventListener('click', () => eliminarFoto(idx));
    div.appendChild(del);
    strip.appendChild(div);
  });
  const ultima = state.fotos[state.fotos.length - 1];
  $('fotoCounter').textContent = `${state.fotos.length} / ${MAX_FOTOS}` + (ultima ? ` · ${ultima.width}×${ultima.height}` : '');
  btnDisparar.disabled = !puedeDisparar();
  $('btnFinalizar').disabled = state.fotos.length === 0;
}

const puedeDisparar = () => state.fotos.length < MAX_FOTOS && state.nextShotNumber <= MAX_DISPAROS;

function eliminarFoto(idx) {
  const [foto] = state.fotos.splice(idx, 1);
  if (foto) URL.revokeObjectURL(foto.objectUrl);
  renderThumbs();
}

const canvasToBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

// Devuelve la mejor fuente disponible: la foto del sensor (ImageCapture) si
// es de mayor resolución y viene en la misma orientación que lo que ve el
// usuario; si no, el cuadro actual del video.
async function obtenerFuente() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (state.imageCapture) {
    try {
      const blob = await state.imageCapture.takePhoto();
      const bmp = await createImageBitmap(blob);
      const mismaOrientacion = (bmp.width >= bmp.height) === (vw >= vh);
      if (mismaOrientacion && bmp.width * bmp.height > vw * vh) {
        return { src: bmp, w: bmp.width, h: bmp.height, fuente: 'sensor', liberar: () => bmp.close() };
      }
      bmp.close();
    } catch (_) { /* sigue con grabFrame */ }
    try {
      // Cuadro del track a resolución completa, sin depender del <video>.
      const bmp = await state.imageCapture.grabFrame();
      if (bmp.width * bmp.height >= vw * vh) {
        return { src: bmp, w: bmp.width, h: bmp.height, fuente: 'frame', liberar: () => bmp.close() };
      }
      bmp.close();
    } catch (_) { /* cae al cuadro de video */ }
  }
  return { src: video, w: vw, h: vh, fuente: 'video', liberar: () => {} };
}

const LADO_MINIMO = 640; // por debajo de esto la cámara no está lista o es inservible

// QR en la esquina inferior derecha: negro sólido, blanco ~30% opaco.
function dibujarQr(canvas, qrCanvas) {
  const ctx = canvas.getContext('2d');
  const size = Math.max(64, Math.round(canvas.width * 0.055));
  const pad = Math.round(size * 0.1);
  ctx.drawImage(qrCanvas, canvas.width - size - pad, canvas.height - size - pad, size, size);
}

async function capturarFoto(qrTexto) {
  const qrCanvas = await QRCode.toCanvas(qrTexto, {
    margin: 0, width: 400,
    color: { dark: '#000000ff', light: '#ffffff4d' }
  });
  const fuente = await obtenerFuente();
  try {
    if (Math.max(fuente.w, fuente.h) < LADO_MINIMO) {
      throw new Error(`resolución insuficiente (${fuente.w}×${fuente.h})`);
    }
    const scale = Math.min(1, FOTO_MAX_LADO / Math.max(fuente.w, fuente.h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(fuente.w * scale);
    canvas.height = Math.round(fuente.h * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fuente.src, 0, 0, canvas.width, canvas.height);
    dibujarQr(canvas, qrCanvas);
    let blob = null;
    for (const q of [FOTO_CALIDAD_JPEG, 0.92, 0.88, 0.82]) {
      blob = await canvasToBlob(canvas, q);
      if (blob && blob.size <= FOTO_MAX_BYTES) break;
    }
    return blob ? { blob, width: canvas.width, height: canvas.height, fuente: fuente.fuente } : null;
  } finally {
    fuente.liberar();
  }
}

btnDisparar.addEventListener('click', async () => {
  if (!puedeDisparar() || !video.videoWidth || !state.ticketCode) return;
  btnDisparar.disabled = true;
  camaraError.textContent = '';
  try {
    const shotNumber = state.nextShotNumber++;
    const res = await capturarFoto(`${state.ticketCode}-${nn(shotNumber)}`);
    if (!res) throw new Error('el navegador no pudo generar la imagen');
    state.fotos.push({ ...res, objectUrl: URL.createObjectURL(res.blob), capturedAt: Date.now(), shotNumber });
    renderThumbs();
  } catch (e) {
    camaraError.textContent = 'No se pudo tomar la foto (la cámara todavía no está lista). Esperá un segundo y probá de nuevo.';
    console.error(e);
  } finally {
    btnDisparar.disabled = !puedeDisparar();
  }
});

function detenerCamara() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
    state.imageCapture = null;
  }
}

/* 4. Subida ------------------------------------------------------------- */

function generarTicketCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 símbolos, sin 0/O/1/I/L
  const out = [];
  const buf = new Uint8Array(1);
  while (out.length < 6) {
    crypto.getRandomValues(buf);
    if (buf[0] < 248) out.push(chars[buf[0] % 31]); // 248 = 8*31: sin sesgo de módulo
  }
  return out.join('');
}

// Sube el original a Cloudinary (unsigned preset, sin secretos en el
// cliente) con barra de progreso por foto.
function subirACloudinary(blob, ticket, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', blob);
    fd.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    fd.append('tags', ticket);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY_CLOUD_NAME)}/image/upload`);
    xhr.timeout = 180000;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error('Cloudinary respondió ' + xhr.status));
      try {
        const data = JSON.parse(xhr.responseText);
        if (typeof data.secure_url !== 'string' || !data.secure_url.startsWith(CLOUDINARY_URL_PREFIX)) {
          return reject(new Error('Respuesta inesperada de Cloudinary'));
        }
        resolve(data);
      } catch (e) { reject(e); }
    };
    xhr.onerror = () => reject(new Error('Error de red'));
    xhr.ontimeout = () => reject(new Error('Tiempo de espera agotado'));
    xhr.send(fd);
  });
}

async function conReintentos(fn, intentos = 3) {
  let ultimoError;
  for (let i = 1; i <= intentos; i++) {
    try { return await fn(); }
    catch (e) {
      ultimoError = e;
      if (i < intentos) await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  throw ultimoError;
}

async function subirLote() {
  if (state.subiendo || state.fotos.length === 0) return;
  state.subiendo = true;
  detenerCamara();
  showScreen('screenSubiendo');
  $('reintentarRow').classList.add('hidden');
  const fill = $('subProgressFill');
  const label = $('subProgressLabel');
  const log = $('subLog');
  const total = state.fotos.length;
  const pintar = (hechas, parcial = 0) => {
    fill.style.width = Math.round(((hechas + parcial) / total) * 100) + '%';
    label.textContent = `${hechas} / ${total}`;
  };
  pintar(state.subidas.size);

  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    const uid = auth.currentUser.uid;

    if (!state.loteCreado) {
      const loteRef = doc(collection(db, 'lotes'));
      await setDoc(loteRef, {
        ticketCode: state.ticketCode,
        agente: state.agente,
        patente: state.patente || null,
        ubicacion: state.ubicacion,
        status: 'pendiente',
        fotoCount: state.fotos.length,
        createdAt: serverTimestamp(),
        creatorUid: uid,
        userAgent: navigator.userAgent.slice(0, 400)
      });
      state.loteId = loteRef.id;
      state.loteCreado = true;
    }

    for (const foto of state.fotos) {
      if (state.subidas.has(foto.shotNumber)) continue;
      const hechas = state.subidas.size;
      log.textContent = `Subiendo foto ${hechas + 1} de ${total} (${(foto.blob.size / 1048576).toFixed(1)} MB)…`;
      const data = await conReintentos(() => subirACloudinary(foto.blob, state.ticketCode, (p) => pintar(hechas, p)));
      await conReintentos(() => setDoc(doc(db, 'lotes', state.loteId, 'fotos', nn(foto.shotNumber)), {
        url: data.secure_url,
        publicId: String(data.public_id || '').slice(0, 200),
        capturedAt: foto.capturedAt,
        order: foto.shotNumber,
        width: Math.round(Number(data.width) || foto.width),
        height: Math.round(Number(data.height) || foto.height),
        bytes: Math.round(Number(data.bytes) || foto.blob.size),
        fuente: foto.fuente
      }));
      state.subidas.add(foto.shotNumber);
      pintar(state.subidas.size);
    }

    mostrarTicket();
  } catch (e) {
    console.error(e);
    log.textContent = 'Se cortó la subida (' + (e && e.message ? e.message : 'error desconocido') + '). Tus fotos siguen en este dispositivo.';
    label.textContent = `${state.subidas.size} / ${total} subidas`;
    $('reintentarRow').classList.remove('hidden');
  } finally {
    state.subiendo = false;
  }
}

$('btnFinalizar').addEventListener('click', subirLote);
$('btnReintentarSubida').addEventListener('click', subirLote);

/* 5. Ticket ------------------------------------------------------------- */

const nombreArchivo = (foto) => `${state.ticketCode}-${nn(foto.shotNumber)}.jpg`;

function mostrarTicket() {
  $('ticketCode').textContent = state.ticketCode;
  const waMsg = encodeURIComponent(`Hola, envío el ticket de mis fotos: ${state.ticketCode}`);
  $('btnWhatsapp').href = `https://wa.me/?text=${waMsg}`;

  const archivos = state.fotos.map((f) => new File([f.blob], nombreArchivo(f), { type: 'image/jpeg' }));

  $('btnGuardarFotos').onclick = () => {
    state.fotos.forEach((foto, i) => {
      setTimeout(() => descargar(foto.objectUrl, nombreArchivo(foto)), i * 150);
    });
  };

  const btnCompartir = $('btnCompartirFotos');
  if (navigator.canShare && navigator.canShare({ files: archivos })) {
    btnCompartir.classList.remove('hidden');
    btnCompartir.onclick = () => navigator.share({
      files: archivos, title: 'Fotos ' + state.ticketCode, text: `Ticket ${state.ticketCode}`
    }).catch(() => {});
  } else {
    btnCompartir.classList.add('hidden');
  }
  showScreen('screenTicket');
}

function descargar(url, nombre) {
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$('btnDescargarZip').addEventListener('click', async () => {
  const btn = $('btnDescargarZip');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generando ZIP…';
  try {
    const zip = new JSZip();
    // STORE: los JPEG ya están comprimidos, recomprimir solo gasta batería.
    for (const foto of state.fotos) zip.file(nombreArchivo(foto), foto.blob, { compression: 'STORE' });
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    descargar(url, `${state.ticketCode}.zip`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

$('btnNuevoLote').addEventListener('click', () => {
  state.fotos.forEach(f => URL.revokeObjectURL(f.objectUrl));
  Object.assign(state, {
    fotos: [], ubicacion: null, loteId: null, loteCreado: false, subidas: new Set(),
    ticketCode: null, nextShotNumber: 1, patente: ''
  });
  $('patenteInput').value = '';
  $('ticketPreview').textContent = '';
  renderThumbs();
  showScreen('screenInicio');
});

window.addEventListener('beforeunload', (e) => {
  if (state.subiendo || state.subidas.size < state.fotos.length) {
    e.preventDefault();
    e.returnValue = '';
  }
});
window.addEventListener('pagehide', detenerCamara);
