/**
 * Validador de fotos — receptor en Google Apps Script.
 *
 * Todo queda en TU cuenta de Google:
 *   - Fotos:          Google Drive > "Validador de fotos" > AAAA-MM > TICKET > TICKET-NN.jpg
 *   - Base de datos:  esta Planilla (hojas "Lotes" y "Fotos")
 *   - Panel admin:    admin.html del sitio (usuario + contraseña propios, ver
 *                     "Validador > Crear o cambiar usuario admin"), y también
 *                     el menú "Validador" de esta Planilla.
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
 *   - Topes globales contra abuso (DoS / llenar el Drive): lotes por hora,
 *     lotes por día y GB de fotos por día (CONFIG). Se guardan en
 *     PropertiesService para que no se pierdan.
 *   - Errores genéricos hacia afuera (sin detalles internos).
 *   - Las celdas de texto se neutralizan contra "inyección de fórmulas" (=, +, -, @).
 */

const CONFIG = {
  CARPETA_RAIZ: 'Validador de fotos',
  MAX_FOTOS: 20,
  MAX_NRO_FOTO: 99,
  MAX_BYTES_FOTO: 15 * 1024 * 1024,
  VENTANA_SUBIDA_MS: 2 * 60 * 60 * 1000,
  // Topes globales (sin login no se puede limitar por persona: Apps Script no
  // recibe la IP). Ajustalos según el uso real.
  MAX_LOTES_POR_HORA: 40,
  MAX_LOTES_POR_DIA: 200,
  MAX_GB_POR_DIA: 5,
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
  'capturadaCelular', 'recibida', 'sha256', 'archivoId', 'miniId'];

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
      // Panel admin web: todas (salvo el login) exigen sesión válida.
      case 'adminLogin': return json_(adminLogin_(body));
      case 'adminLogout': return json_(adminLogout_(body));
      case 'adminLotes': return json_(adminLotes_(body));
      case 'adminLote': return json_(adminLote_(body));
      case 'adminMinis': return json_(adminMinis_(body));
      case 'adminMini': return json_(adminMini_(body));
      case 'adminOriginal': return json_(adminOriginal_(body));
      case 'adminRevisar': return json_(adminRevisar_(body));
      case 'adminVerificar': return json_(adminVerificar_(body));
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
  // "patente" = referencia libre del bien (chapa, dirección, póliza…).
  const patente = texto_(b.patente, 60).replace(/[^\p{L}\p{N} .,:;#/°ºª()+-]/gu, '');
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
    const uso = usoHoy_();
    if (uso.lotes >= CONFIG.MAX_LOTES_POR_DIA) throw publico_('limite_diario');
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
    uso.lotes++;
    guardarUso_(uso);
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
  if (!esJpeg_(bytes)) throw publico_('no_es_jpeg');
  // Miniatura opcional (la genera el celular) para previsualizar rápido en el admin.
  let mini = null;
  if (typeof b.mini === 'string' && b.mini.length > 100 && b.mini.length < 600000) {
    const mb = Utilities.base64Decode(b.mini);
    if (esJpeg_(mb)) mini = mb;
  }

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
    const uso = usoHoy_();
    if (uso.bytes + bytes.length > CONFIG.MAX_GB_POR_DIA * 1024 * 1024 * 1024) throw publico_('limite_diario');

    const archivo = carpeta.createFile(Utilities.newBlob(bytes, 'image/jpeg', nombre));
    archivo.setDescription(`Ticket ${lote.ticket} · foto ${nro} · agente ${lote.fila.agente}`);
    const sha = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
    const miniId = mini ? subcarpeta_(carpeta, 'miniaturas').createFile(Utilities.newBlob(mini, 'image/jpeg', nombre)).getId() : '';
    const capt = Number(b.capturedAt);
    hoja_(HOJA_FOTOS).appendRow(fila_(COL_FOTOS, {
      ticket: lote.ticket, nro, archivo: archivo.getUrl(), bytes: bytes.length,
      ancho: entero_(b.width), alto: entero_(b.height), fuente: seguroCelda_(texto_(b.fuente, 10)),
      capturadaCelular: capt > 0 ? new Date(capt) : '', recibida: new Date(), sha256: sha,
      archivoId: archivo.getId(), miniId
    }));
    celdaRecibidas.setValue(recibidas + 1);
    if (mini && b.mini.length <= MAX_CACHE_VALOR) {
      try { CacheService.getScriptCache().put(claveMini_(lote.ticket, nro), b.mini, CACHE_MINI_S); } catch (_) { /* no crítico */ }
    }
    uso.bytes += bytes.length + (mini ? mini.length : 0);
    guardarUso_(uso);
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
    .addItem('Crear o cambiar usuario admin', 'crearAdmin')
    .addItem('Borrar usuario admin', 'borrarAdmin')
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
/* Panel admin web (admin.html)                                            */
/* ====================================================================== */
//
// OWASP A07: contraseñas con sal + 3000 rondas de HMAC-SHA256 (nunca en
// texto plano), bloqueo tras 5 intentos fallidos (15 min) y tope global por
// hora, sesión aleatoria de 256 bits que vence a los 30 min sin uso (máx. 8 h),
// mismo mensaje de error para usuario o contraseña incorrectos.

const SESION_INACTIVIDAD_S = 30 * 60;
const SESION_MAX_MS = 8 * 60 * 60 * 1000;
const ITER_CLAVE = 3000;
const TICKET_RE = /^[A-HJKMNP-Z2-9]{6}$/;

function adminLogin_(b) {
  const usuario = String(b.usuario || '').trim().toLowerCase().slice(0, 60);
  const clave = String(b.clave || '').slice(0, 200);
  const cache = CacheService.getScriptCache();
  const kU = 'fallos_u_' + sha256_(usuario);
  const kG = 'fallos_g_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  const fU = Number(cache.get(kU) || 0), fG = Number(cache.get(kG) || 0);
  if (fU >= 5 || fG >= 30) throw publico_('bloqueado');

  const reg = leerAdmins_()[usuario];
  // Se calcula el hash aunque el usuario no exista: mismo tiempo de respuesta.
  const hash = hashClave_(clave, reg ? reg.salt : '00000000000000000000000000000000');
  if (!reg || !igualSeguro_(hash, reg.hash)) {
    cache.put(kU, String(fU + 1), 900);
    cache.put(kG, String(fG + 1), 3700);
    throw publico_('credenciales_invalidas');
  }
  cache.remove(kU);
  const token = tokenAleatorio_();
  cache.put('ses_' + sha256_(token), JSON.stringify({ usuario: usuario, inicio: Date.now() }), SESION_INACTIVIDAD_S);
  return { ok: true, sesion: token, usuario: usuario };
}

function adminLogout_(b) {
  const token = String(b.sesion || '');
  if (/^[a-f0-9]{64}$/.test(token)) CacheService.getScriptCache().remove('ses_' + sha256_(token));
  return { ok: true };
}

function sesion_(b) {
  const token = String(b.sesion || '');
  if (!/^[a-f0-9]{64}$/.test(token)) throw publico_('sesion_invalida');
  const cache = CacheService.getScriptCache();
  const k = 'ses_' + sha256_(token);
  const v = cache.get(k);
  if (!v) throw publico_('sesion_invalida');
  const s = JSON.parse(v);
  if (Date.now() - s.inicio > SESION_MAX_MS || !leerAdmins_()[s.usuario]) {
    cache.remove(k);
    throw publico_('sesion_invalida');
  }
  cache.put(k, v, SESION_INACTIVIDAD_S); // renueva por actividad
  return s;
}

function adminLotes_(b) {
  sesion_(b);
  const filas = hoja_(HOJA_LOTES).getDataRange().getValues().slice(1).filter(r => r[0]);
  const lotes = filas.map(loteDeFila_)
    .sort((x, y) => String(y.creado || '').localeCompare(String(x.creado || '')))
    .slice(0, 1000);
  const uso = usoHoy_();
  return {
    ok: true, lotes: lotes,
    uso: { lotes: uso.lotes, maxLotes: CONFIG.MAX_LOTES_POR_DIA, gb: uso.bytes / 1073741824, maxGb: CONFIG.MAX_GB_POR_DIA }
  };
}

function adminLote_(b) {
  sesion_(b);
  const ticket = ticketValido_(b.ticket);
  const lote = buscarLote_(ticket);
  if (!lote) throw publico_('no_encontrado');
  lote.fotos = fotosDe_(ticket).map(f => ({
    nro: f.nro, bytes: f.bytes, ancho: f.ancho, alto: f.alto, fuente: f.fuente,
    capturadaCelular: f.capturadaCelular, recibida: f.recibida, sha256: f.sha256,
    tieneMini: !!f.miniId
  }));
  const claves = lote.fotos.map(f => claveMini_(ticket, f.nro));
  const enCache = claves.length ? CacheService.getScriptCache().getAll(claves) : {};
  lote.minis = {};
  lote.fotos.forEach((f, i) => { lote.minis[f.nro] = enCache[claves[i]] || null; });
  return { ok: true, lote: lote };
}

function adminMinis_(b) {
  sesion_(b);
  const ticket = ticketValido_(b.ticket);
  const minis = {};
  fotosDe_(ticket).forEach(f => { minis[f.nro] = miniDe_(ticket, f); });
  return { ok: true, minis: minis };
}

function adminMini_(b) {
  sesion_(b);
  const ticket = ticketValido_(b.ticket);
  const nro = Number(b.nro);
  const f = fotosDe_(ticket).find(x => Number(x.nro) === nro);
  if (!f) throw publico_('no_encontrado');
  return { ok: true, nro: nro, mini: miniDe_(ticket, f) };
}

function adminOriginal_(b) {
  sesion_(b);
  const ticket = ticketValido_(b.ticket);
  const nro = Number(b.nro);
  const f = fotosDe_(ticket).find(x => Number(x.nro) === nro);
  if (!f) throw publico_('no_encontrado');
  const bytes = DriveApp.getFileById(f.archivoId).getBlob().getBytes();
  return { ok: true, nombre: ticket + '-' + String(nro).padStart(2, '0') + '.jpg', data: Utilities.base64Encode(bytes) };
}

function adminRevisar_(b) {
  const s = sesion_(b);
  const ticket = ticketValido_(b.ticket);
  const estado = String(b.estado || '');
  if (CONFIG.ESTADOS.indexOf(estado) < 0) throw publico_('estado_invalido');
  const hoja = hoja_(HOJA_LOTES);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const nroFila = buscarFila_(hoja, ticket);
    if (!nroFila) throw publico_('no_encontrado');
    const c = (n) => COL_LOTES.indexOf(n) + 1;
    hoja.getRange(nroFila, c('estado')).setValue(estado);
    hoja.getRange(nroFila, c('nota')).setValue(seguroCelda_(texto_(b.nota, 1000)));
    hoja.getRange(nroFila, c('revisadoPor')).setValue(seguroCelda_(s.usuario));
    hoja.getRange(nroFila, c('revisadoAt')).setValue(new Date());
  } finally {
    lock.releaseLock();
  }
  return { ok: true, lote: buscarLote_(ticket) };
}

// QR escaneado ("TICKET-NN"): ¿existe esa foto en la base?
function adminVerificar_(b) {
  sesion_(b);
  const m = /^([A-HJKMNP-Z2-9]{6})-(\d{2})$/.exec(String(b.codigo || '').trim());
  if (!m) return { ok: true, valido: false, motivo: 'formato' };
  const lote = buscarLote_(m[1]);
  if (!lote) return { ok: true, valido: false, motivo: 'ticket' };
  const f = fotosDe_(m[1]).find(x => Number(x.nro) === Number(m[2]));
  if (!f) return { ok: true, valido: false, motivo: 'foto', lote: lote };
  return {
    ok: true, valido: true, lote: lote,
    foto: { nro: f.nro, capturadaCelular: f.capturadaCelular, recibida: f.recibida, sha256: f.sha256 },
    mini: miniDe_(m[1], f)
  };
}

/* --- usuarios admin (se gestionan desde el menú de la Planilla) --- */

function crearAdmin() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('Usuario admin', 'Nombre de usuario (letras, números, punto o guion):', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const usuario = r1.getResponseText().trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,60}$/.test(usuario)) { ui.alert('Usuario inválido.'); return; }
  const r2 = ui.prompt('Contraseña para "' + usuario + '"', 'Mínimo 12 caracteres. Usá una frase larga que no uses en otro lado.', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const clave = r2.getResponseText();
  if (clave.length < 12) { ui.alert('La contraseña debe tener al menos 12 caracteres.'); return; }
  const admins = leerAdmins_();
  const salt = tokenAleatorio_().slice(0, 32);
  admins[usuario] = { salt: salt, hash: hashClave_(clave, salt), creado: new Date().toISOString() };
  PropertiesService.getScriptProperties().setProperty('ADMINS', JSON.stringify(admins));
  ui.alert('Listo: el usuario "' + usuario + '" ya puede entrar a admin.html.');
}

function borrarAdmin() {
  const ui = SpreadsheetApp.getUi();
  const admins = leerAdmins_();
  const lista = Object.keys(admins);
  if (!lista.length) { ui.alert('No hay usuarios admin.'); return; }
  const r = ui.prompt('Borrar usuario admin', 'Usuarios: ' + lista.join(', ') + '\n\nEscribí el usuario a borrar:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const u = r.getResponseText().trim().toLowerCase();
  if (!admins[u]) { ui.alert('Ese usuario no existe.'); return; }
  delete admins[u];
  PropertiesService.getScriptProperties().setProperty('ADMINS', JSON.stringify(admins));
  ui.alert('Usuario "' + u + '" borrado (sus sesiones abiertas dejan de valer).');
}

/* --- auxiliares del admin --- */

function leerAdmins_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('ADMINS') || '{}'); }
  catch (_) { return {}; }
}

function hashClave_(clave, salt) {
  const key = Utilities.newBlob(clave).getBytes();
  let h = Utilities.computeHmacSha256Signature(Utilities.newBlob(salt).getBytes(), key);
  for (let i = 1; i < ITER_CLAVE; i++) h = Utilities.computeHmacSha256Signature(h, key);
  return hex_(h);
}

function tokenAleatorio_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function ticketValido_(t) {
  const ticket = String(t || '');
  if (!TICKET_RE.test(ticket)) throw publico_('ticket_invalido');
  return ticket;
}

function loteDeFila_(r) {
  const l = {};
  COL_LOTES.forEach((k, i) => { if (k !== 'tokenHash') l[k] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
  return l;
}

function buscarLote_(ticket) {
  const hoja = hoja_(HOJA_LOTES);
  const nroFila = buscarFila_(hoja, ticket);
  if (!nroFila) return null;
  return loteDeFila_(hoja.getRange(nroFila, 1, 1, COL_LOTES.length).getValues()[0]);
}

function fotosDe_(ticket) {
  const hoja = hoja_(HOJA_FOTOS);
  const ultima = hoja.getLastRow();
  if (ultima < 2) return [];
  // Rápido: primero solo la columna A (tickets), después el bloque de filas
  // que contiene ese ticket (las fotos de un lote quedan casi siempre juntas).
  const tickets = hoja.getRange(2, 1, ultima - 1, 1).getValues();
  let desde = -1, hasta = -1;
  for (let i = 0; i < tickets.length; i++) {
    if (tickets[i][0] === ticket) { if (desde < 0) desde = i; hasta = i; }
  }
  if (desde < 0) return [];
  return hoja.getRange(desde + 2, 1, hasta - desde + 1, COL_FOTOS.length).getValues()
    .filter(r => r[0] === ticket)
    .map(r => {
      const f = {};
      COL_FOTOS.forEach((k, i) => { f[k] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
      return f;
    })
    .sort((a, b) => a.nro - b.nro);
}

const CACHE_MINI_S = 6 * 60 * 60;     // máximo que permite CacheService
const MAX_CACHE_VALOR = 100000;        // tope por valor de CacheService

function claveMini_(ticket, nro) { return 'mini_' + ticket + '_' + Number(nro); }

// Miniatura desde la caché rápida; si no está, desde Drive (y se guarda en caché).
function miniDe_(ticket, f) {
  const cache = CacheService.getScriptCache();
  const k = claveMini_(ticket, f.nro);
  const c = cache.get(k);
  if (c) return c;
  const b64 = miniBase64_(f);
  if (b64 && b64.length <= MAX_CACHE_VALOR) { try { cache.put(k, b64, CACHE_MINI_S); } catch (_) { /* no crítico */ } }
  return b64;
}

function miniBase64_(f) {
  try {
    const blob = f.miniId ? DriveApp.getFileById(f.miniId).getBlob() : DriveApp.getFileById(f.archivoId).getThumbnail();
    return blob ? Utilities.base64Encode(blob.getBytes()) : null;
  } catch (_) {
    return null;
  }
}

// Uso del día (lotes creados y bytes recibidos), en hora de Paraguay.
function usoHoy_() {
  const clave = 'uso_' + Utilities.formatDate(new Date(), CONFIG.ZONA, 'yyyyMMdd');
  let uso = null;
  try { uso = JSON.parse(PropertiesService.getScriptProperties().getProperty(clave) || 'null'); } catch (_) { uso = null; }
  return { clave: clave, lotes: Number(uso && uso.lotes) || 0, bytes: Number(uso && uso.bytes) || 0 };
}

function guardarUso_(uso) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(uso.clave, JSON.stringify({ lotes: uso.lotes, bytes: uso.bytes }));
  // Limpieza: borra contadores de días anteriores.
  props.getKeys().forEach(k => { if (k.indexOf('uso_') === 0 && k !== uso.clave) props.deleteProperty(k); });
}

function esJpeg_(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return (bytes[0] & 0xff) === 0xff && (bytes[1] & 0xff) === 0xd8 && (bytes[2] & 0xff) === 0xff
    && (bytes[bytes.length - 2] & 0xff) === 0xff && (bytes[bytes.length - 1] & 0xff) === 0xd9;
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
