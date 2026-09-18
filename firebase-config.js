// Configuración de Firebase para Validador de fotos.
//
// Completar los valores de abajo con los de tu proyecto de Firebase:
// Firebase Console > (ícono de engranaje) Configuración del proyecto > "Tus apps"
// > app web > "Config". Los pasos completos para crear el proyecto están en README.md.
//
// Este archivo se importa desde index.html y admin.html como módulo ES:
//   import { auth, db } from './firebase-config.js';
//
// Nota: no usamos Firebase Storage a propósito. Desde fines de 2024, Storage
// exige el plan de pago Blaze incluso para uso dentro de la capa gratuita.
// Para evitar pedir una tarjeta, las fotos se guardan como texto (base64)
// directamente en los documentos de Firestore, que sigue siendo 100% gratis
// en el plan Spark. Esto limita cada foto a ~700KB (se comprime al capturarla
// en index.html) y el total del proyecto a 1GB de almacenamiento gratuito en
// Firestore — de sobra para probar, pero si esto escala a mucho volumen real,
// conviene migrar a Storage (activando Blaze) más adelante.

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

// Tamaño máximo (en bytes, del JPEG antes de convertir a base64) por foto,
// para que cada documento de Firestore se mantenga bien por debajo de su
// límite de 1MB. 700KB en base64 pesa ~935KB, dejando margen de sobra.
export const MAX_FOTO_BYTES = 700 * 1024;
