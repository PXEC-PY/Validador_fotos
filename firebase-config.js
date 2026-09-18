// Configuración de Firebase + Cloudinary para Validador de fotos.
//
// Completar los valores de abajo con los de tu proyecto de Firebase:
// Firebase Console > (ícono de engranaje) Configuración del proyecto > "Tus apps"
// > app web > "Config". Los pasos completos para crear el proyecto están en README.md.
//
// Este archivo se importa desde index.html y admin.html como módulo ES:
//   import { auth, db } from './firebase-config.js';
//
// Nota sobre las fotos: no usamos Firebase Storage (desde fines de 2024 exige
// el plan de pago Blaze) ni las guardamos en Firestore (limitaba la calidad a
// ~700KB por el tope de 1MB por documento). Las fotos se suben directo del
// navegador a Cloudinary (gratis, sin tarjeta) usando un "unsigned upload
// preset" — no expone ninguna clave secreta en el código. Firestore solo
// guarda el link (`url`) a cada foto, así que no hay límite de calidad real.
// Ver README.md para los pasos de configuración de Cloudinary.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBxq6LrFU3RbYknN4sg4kxiGfKbfbHBhvY",
  authDomain: "validador-fotos-44f0a.firebaseapp.com",
  projectId: "validador-fotos-44f0a",
  storageBucket: "validador-fotos-44f0a.firebasestorage.app",
  messagingSenderId: "291643372514",
  appId: "1:291643372514:web:b67e79454f5f8a464abfbb"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Máximo de fotos por lote.
export const MAX_FOTOS = 20;

// Datos de tu cuenta de Cloudinary (Dashboard > "Cloud name", y Settings >
// Upload > Upload presets > crear uno con Signing Mode = "Unsigned").
// Ninguno de los dos valores es secreto: están pensados para usarse desde
// el navegador.
export const CLOUDINARY_CLOUD_NAME = "REEMPLAZAR_CLOUD_NAME";
export const CLOUDINARY_UPLOAD_PRESET = "REEMPLAZAR_UPLOAD_PRESET";
