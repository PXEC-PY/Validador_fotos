// Configuración del Validador de fotos.
//
// Todo se guarda en TU cuenta de Google (Drive + Planilla) a través de un
// Google Apps Script. No hay Firebase, Cloudinary ni servicios de terceros.
// Pasos de instalación: apps-script/README.md.

// URL de la "Aplicación web" del Apps Script (termina en /exec).
// No es secreta: es la dirección a la que los celulares mandan las fotos.
// Toda la validación se hace del lado de Google (apps-script/Codigo.gs).
export const APPS_SCRIPT_URL = "";

// Máximo de fotos por lote (tiene que coincidir con CONFIG.MAX_FOTOS en Codigo.gs).
export const MAX_FOTOS = 20;

// Calidad de captura: resolución nativa de la cámara hasta 4096 px de lado
// mayor (tope seguro de canvas en iPhone) y JPEG 0.95.
export const FOTO_MAX_LADO = 4096;
export const FOTO_CALIDAD_JPEG = 0.95;
// Si una foto pasa este peso se re-codifica un poco más comprimida
// (Codigo.gs acepta hasta 15 MB).
export const FOTO_MAX_BYTES = 12 * 1024 * 1024;
