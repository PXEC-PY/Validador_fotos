/**
 * Validador de fotos — receptor en Google Apps Script.
 *
 * Todo queda en TU cuenta de Google:
 *   - Fotos:          Google Drive > "Validador de fotos" > AAAA-MM > TICKET > TICKET-NN.jpg
 *   - Base de datos:  esta Planilla (hojas "Lotes" y "Fotos")
 *   - Panel admin:    menú "Validador" de esta Planilla (protegido por tu login de Google)
 *
 * Instalación: ver apps-script/README.md.
 *
 * Seguridad (OWASP):
 *   - El endpoint es público (los brokers no tienen cuenta), así que NO se
 *     confía en nada que mande el navegador: todo se valida acá.
 *   - El ticket y un token secreto por lote los genera el servidor. Para subir
 *     una foto hay que presentar el token; en la planilla solo se guarda su hash.
 *   - Solo JPEG reales (se revisan los bytes), tamaño máximo, máximo 20 fotos,
 *     solo mientras el lote está pendiente y dentro de las 2 h de creado.
 *   - Tope global de lotes por hora contra abuso/llenado del Drive.
 *   - Errores genéricos hacia afuera (sin detalles internos).
 *   - Las celdas de texto se neutralizan contra "inyección de fórmulas" (=, +, -, @).
 */

const CONFIG = {
  CARPETA_RAIZ: 'Validador de fotos',
  MAX_FOTOS: 20,
  MAX_NRO_FOTO: 99,
  MAX_BYTES_FOTO: 15 * 1024 * 1024,
  VENTANA_SUBIDA_MS: 2 * 60 * 60 * 1000,
  MAX_LOTES_POR_HORA: 120,
  TICKET_CHARS: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  ESTADOS: ['pendiente', 'aprobado', 'rechazado'],
  ZONA: 'America/Asuncion'
};

const HOJA_LOTES = 'Lotes';
const HOJA_FOTOS = 'Fotos';
const COL_LOTES = ['ticket', 'estado', 'agente', 'patente', 'fotosRecibidas', 'fotosDeclaradas',
  'creado', 'cerrado', 'lat', 'lng', 'precisionM', 'gpsCapturado', 'carpeta', 'nota',
  'revisadoPor', 'revisadoAt', 'userAgent', 'tokenHash'];
const COL_FOTOS = ['ticket', 'nro', 'archivo', 'bytes', 'ancho', 'alto', 'fuente',
  'capturadaCelular', 'recibida', 'sha256', 'archivoId'];

/* ====================================================================== */
/* Endpoint público                                                        */
/* ====================================================================== */

function doGet() {
  return json_({ ok: true, servicio: 'validador-fotos' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return json_({ ok: false, error: 'pedido_vacio' });
    if (e.postData.contents.length > 25 * 1024 * 1024) return json_({ ok: false, error: 'demasiado_grande' });
    const body = JSON.parse(e.postData.contents);
    switch (body && body.accion) {
      case 'crearLote': return json_(crearLote_(body));
      case 'subirFoto': return json_(subirFoto_(body));
      case 'cerrarLote': return json_(cerrarLote_(body));
      default: return json_({ ok: false, error: 'accion_invalida' });
    }
  } catch (err) {
    if (!(err && err.publico)) console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: err && err.publico ? err.message : 'error_interno' });
  }
}

/* ---------------------------------------------------------------------- */

function crearLote_(b) {
  const agente = texto_(b.agente, 80);
  if (agente.length < 2) throw publico_('agente_invalido');
  const patente = String(b.patente || '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').trim().slice(0, 12);
  const u = b.ubicacion || {};
  const lat = Number(u.lat), lng = Number(u.lng), acc = Number(u.accuracy), gpsAt = Number(u.capturedAt);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && acc >= 0 && acc < 100000)) throw publico_('ubicacion_invalida');

  // Tope global por hora (no hay IP del cliente en Apps Script).
  const cache = CacheService.getScriptCache();
  const claveHora = 'lotes_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  const usados = Number(cache.get(claveHora) || 0);
  if (usados >= CONFIG.MAX_LOTES_POR_HORA) throw publico_('limite_alcanzado');
  cache.put(claveHora, String(usados + 1), 3700);

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const ahora = new Date();
  let ticket;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_(HOJA_LOTES);
    do { ticket = generarTicket_(); } while (buscarFila_(hoja, ticket));
    const carpeta = carpetaLote_(ticket, ahora);
    hoja.appendRow(fila_(COL_LOTES, {
      ticket, estado: 'pendiente', agente: seguroCelda_(agente), patente: seguroCelda_(patente),
      fotosRecibidas: 0, fotosDeclaradas: '', creado: ahora, cerrado: '',
      lat, lng, precisionM: Math.round(acc),
      gpsCapturado: gpsAt > 0 ? new Date(gpsAt) : '',
      carpeta: carpeta.getUrl(), nota: '', revisadoPor: '', revisadoAt: '',
      userAgent: seguroCelda_(texto_(b.userAgent, 300)), tokenHash: sha256_(token)
    }));
  } finally {
    lock.releaseLock();
  }
  // El ticket se devuelve al navegador para quemarlo en el QR de cada foto.
  return { ok: true, ticket, token };
}

function subirFoto_(b) {
  const lote = loteAutorizado_(b);
  const nro = Number(b.nro);
  if (!Number.isInteger(nro) || nro < 1 || nro > CONFIG.MAX_NRO_FOTO) throw publico_('nro_invalido');
  if (typeof b.data !== 'string' || b.data.length < 100) throw publico_('foto_invalida');

  const bytes = Utilities.base64Decode(b.data);
  if (bytes.length > CONFIG.MAX_BYTES_FOTO) throw publico_('foto_muy_grande');
  // Firma JPEG: FF D8 FF ... y termina en FF D9.
  const b0 = bytes[0] & 0xff, b1 = bytes[1] & 0xff, b2 = bytes[2] & 0xff;
  const z1 = bytes[bytes.length - 2] & 0xff, z2 = bytes[bytes.length - 1] & 0xff;
  if (!(b0 === 0xff && b1 === 0xd8 && b2 === 0xff && z1 === 0xff && z2 === 0xd9)) throw publico_('no_es_jpeg');

  const nombre = `${lote.ticket}-${String(nro).padStart(2, '0')}.jpg`;
  const carpeta = DriveApp.getFolderById(idDeCarpeta_(lote.fila.carpeta));

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    // Idempotente: si el celular reintenta una foto que ya llegó, no se duplica.
    if (carpeta.getFilesByName(nombre).hasNext()) return { ok: true, duplicada: true };
    const celdaRecibidas = lote.hoja.getRange(lote.nroFila, COL_LOTES.indexOf('fotosRecibidas') + 1);
    const recibidas = Number(celdaRecibidas.getValue()) || 0;
    if (recibidas >= CONFIG.MAX_FOTOS) throw publico_('maximo_de_fotos');

    const archivo = carpeta.createFile(Utilities.newBlob(bytes, 'image/jpeg', nombre));
    archivo.setDescription(`Ticket ${lote.ticket} · foto ${nro} · agente ${lote.fila.agente}`);
    const sha = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
    const capt = Number(b.capturedAt);
    hoja_(HOJA_FOTOS).appendRow(fila_(COL_FOTOS, {
      ticket: lote.ticket, nro, archivo: archivo.getUrl(), bytes: bytes.length,
      ancho: entero_(b.width), alto: entero_(b.height), fuente: seguroCelda_(texto_(b.fuente, 10)),
      capturadaCelular: capt > 0 ? new Date(capt) : '', recibida: new Date(), sha256: sha,
      archivoId: archivo.getId()
    }));
    celdaRecibidas.setValue(recibidas + 1);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function cerrarLote_(b) {
  const lote = loteAutorizado_(b);
  const declaradas = Number(b.fotoCount);
  if (!Number.isInteger(declaradas) || declaradas < 1 || declaradas > CONFIG.MAX_FOTOS) throw publico_('cantidad_invalida');
  const c = (n) => COL_LOTES.indexOf(n) + 1;
  lote.hoja.getRange(lote.nroFila, c('fotosDeclaradas')).setValue(declaradas);
  lote.hoja.getRange(lote.nroFila, c('cerrado')).setValue(new Date());
  return { ok: true, recibidas: Number(lote.fila.fotosRecibidas) || 0 };
}

// Verifica ticket + token, estado pendiente y ventana de tiempo.
function loteAutorizado_(b) {
  const ticket = String(b.ticket || '');
  const token = String(b.token || '');
  if (!/^[A-HJKMNP-Z2-9]{6}$/.test(ticket) || !/^[a-f0-9]{64}$/.test(token)) throw publico_('no_autorizado');
  const hoja = hoja_(HOJA_LOTES);
  const nroFila = buscarFila_(hoja, ticket);
  if (!nroFila) throw publico_('no_autorizado');
  const valores = hoja.getRange(nroFila, 1, 1, COL_LOTES.length).getValues()[0];
  const fila = {};
  COL_LOTES.forEach((k, i) => { fila[k] = valores[i]; });
  if (!igualSeguro_(String(fila.tokenHash), sha256_(token))) throw publico_('no_autorizado');
  if (fila.estado !== 'pendiente') throw publico_('lote_cerrado');
  if (Date.now() - new Date(fila.creado).getTime() > CONFIG.VENTANA_SUBIDA_MS) throw publico_('lote_vencido');
  return { ticket, hoja, nroFila, fila };
}

/* ====================================================================== */
/* Panel admin dentro de la Planilla                                       */
/* ====================================================================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Validador')
    .addItem('Ver fotos del lote seleccionado', 'abrirPanel')
    .addSeparator()
    .addItem('Configurar (primera vez)', 'configurar')
    .addToUi();
}

function abrirPanel() {
  const html = HtmlService.createHtmlOutputFromFile('Panel').setTitle('Lote');
  SpreadsheetApp.getUi().showSidebar(html);
}

// Llamado desde el panel: datos del lote de la fila seleccionada en "Lotes".
function datosLoteSeleccionado() {
  const ss = SpreadsheetApp.getActive();
  const hoja = ss.getActiveSheet();
  if (hoja.getName() !== HOJA_LOTES) return { error: 'Seleccioná una fila en la hoja "Lotes".' };
  const nroFila = hoja.getActiveRange().getRow();
  if (nroFila < 2) return { error: 'Seleccioná la fila de un lote (no el encabezado).' };
  return datosLote_(nroFila);
}

function datosLote_(nroFila) {
  const hoja = hoja_(HOJA_LOTES);
  const v = hoja.getRange(nroFila, 1, 1, COL_LOTES.length).getValues()[0];
  const lote = {};
  COL_LOTES.forEach((k, i) => { lote[k] = v[i] instanceof Date ? fecha_(v[i]) : v[i]; });
  delete lote.tokenHash;
  lote.nroFila = nroFila;

  const fotos = hoja_(HOJA_FOTOS).getDataRange().getValues().slice(1)
    .filter(r => r[0] === lote.ticket)
    .map(r => {
      const f = {};
      COL_FOTOS.forEach((k, i) => { f[k] = r[i] instanceof Date ? fecha_(r[i]) : r[i]; });
      return f;
    })
    .sort((a, b) => a.nro - b.nro);
  lote.fotos = fotos;
  return lote;
}

function revisarLote(nroFila, estado, nota) {
  if (CONFIG.ESTADOS.indexOf(estado) < 0) throw new Error('Estado inválido');
  const hoja = hoja_(HOJA_LOTES);
  const c = (n) => COL_LOTES.indexOf(n) + 1;
  hoja.getRange(nroFila, c('estado')).setValue(estado);
  hoja.getRange(nroFila, c('nota')).setValue(seguroCelda_(texto_(nota, 1000)));
  hoja.getRange(nroFila, c('revisadoPor')).setValue(Session.getActiveUser().getEmail() || 'admin');
  hoja.getRange(nroFila, c('revisadoAt')).setValue(new Date());
  return datosLote_(nroFila);
}

/* ====================================================================== */
/* Configuración inicial                                                   */
/* ====================================================================== */

function configurar() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(CONFIG.ZONA);
  [[HOJA_LOTES, COL_LOTES], [HOJA_FOTOS, COL_FOTOS]].forEach(([nombre, cols]) => {
    const h = ss.getSheetByName(nombre) || ss.insertSheet(nombre);
    h.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    h.setFrozenRows(1);
  });
  const lotes = ss.getSheetByName(HOJA_LOTES);
  const regla = SpreadsheetApp.newDataValidation().requireValueInList(CONFIG.ESTADOS, true).build();
  lotes.getRange(2, 2, lotes.getMaxRows() - 1, 1).setDataValidation(regla);
  lotes.hideColumns(COL_LOTES.indexOf('tokenHash') + 1);
  const hoja1 = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (hoja1 && ss.getSheets().length > 2) ss.deleteSheet(hoja1);
  carpetaRaiz_();
  SpreadsheetApp.getUi().alert('Listo. Ahora: Implementar > Nueva implementación > Aplicación web (ver README).');
}

/* ====================================================================== */
/* Utilidades                                                              */
/* ====================================================================== */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function publico_(codigo) { const e = new Error(codigo); e.publico = true; return e; }

function hoja_(nombre) {
  const h = SpreadsheetApp.getActive().getSheetByName(nombre);
  if (!h) throw new Error('Falta la hoja ' + nombre + ': ejecutá "configurar" primero.');
  return h;
}

function buscarFila_(hoja, ticket) {
  if (hoja.getLastRow() < 2) return 0;
  const r = hoja.getRange(2, 1, hoja.getLastRow() - 1, 1).createTextFinder(ticket).matchEntireCell(true).findNext();
  return r ? r.getRow() : 0;
}

function fila_(cols, obj) { return cols.map(k => (obj[k] === undefined ? '' : obj[k])); }

function generarTicket_() {
  // Bytes aleatorios a partir de UUID v4 (SecureRandom) con rechazo para evitar sesgo.
  const chars = CONFIG.TICKET_CHARS;
  let out = '';
  while (out.length < 6) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid());
    for (let i = 0; i < bytes.length && out.length < 6; i++) {
      const v = bytes[i] & 0xff;
      if (v < 248) out += chars[v % 31];
    }
  }
  return out;
}

function carpetaRaiz_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('CARPETA_RAIZ_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (_) { /* se recrea */ } }
  const carpeta = DriveApp.createFolder(CONFIG.CARPETA_RAIZ);
  props.setProperty('CARPETA_RAIZ_ID', carpeta.getId());
  return carpeta;
}

function subcarpeta_(padre, nombre) {
  const it = padre.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : padre.createFolder(nombre);
}

function carpetaLote_(ticket, fecha) {
  const mes = Utilities.formatDate(fecha, CONFIG.ZONA, 'yyyy-MM');
  return subcarpeta_(subcarpeta_(carpetaRaiz_(), mes), ticket);
}

function idDeCarpeta_(url) {
  const m = /folders\/([A-Za-z0-9_-]+)/.exec(String(url));
  if (!m) throw new Error('URL de carpeta inválida');
  return m[1];
}

function texto_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Evita que un texto del broker se interprete como fórmula en la planilla.
function seguroCelda_(s) { return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }

function entero_(v) { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 && n < 100000 ? n : ''; }

function sha256_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)); }

function hex_(bytes) { return bytes.map(b => ((b & 0xff) + 0x100).toString(16).slice(1)).join(''); }

function igualSeguro_(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function fecha_(d) { return Utilities.formatDate(d, CONFIG.ZONA, 'dd/MM/yyyy HH:mm:ss'); }
