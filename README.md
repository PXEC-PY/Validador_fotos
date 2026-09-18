# Validador de fotos

Sitio estático (sin backend propio) que usa **Firebase** (Auth + Firestore) como base de
datos. Tres páginas:

- `index.html` — el cliente saca hasta 20 fotos del vehículo desde la cámara del
  navegador, confirma su ubicación (GPS del dispositivo, no editable a mano) y sube todo.
  Cada foto queda con un **código QR quemado en la imagen** (`TICKET-NN`) generado con la
  librería [`qrcode`](https://github.com/soldair/node-qrcode). Al final le muestra el
  **código de ticket** para mandar por WhatsApp, y puede descargar todas las fotos en
  `.zip` o guardarlas en la galería del celular (con el QR ya incluido).
- `admin.html` — panel de administración: buscar un lote por ticket, revisar fotos +
  ubicación, aprobar o rechazar, exportar el lote aprobado como ZIP, y **escanear el QR**
  de una foto con la cámara del dispositivo (librería [`jsQR`](https://github.com/cozmo/jsQR))
  para contrastarla contra la fecha/hora y ubicación reales guardadas en Firestore — si
  alguien reusa o falsifica una foto, el escaneo no va a coincidir con ningún registro
  válido.
- `analizador.html` — el analizador forense de metadatos original (sin cambios), útil
  para revisar a mano la captura de WhatsApp que manda el cliente.

No hay paso de build: son archivos HTML/CSS/JS planos que se sirven tal cual (GitHub
Pages, o cualquier hosting estático).

**Nota sobre las fotos:** no usamos Firebase Storage a propósito, porque desde fines de
2024 exige activar el plan de pago Blaze (con tarjeta) incluso para uso gratuito. En vez
de eso, cada foto se comprime en el navegador (máx. ~600KB) y se guarda como texto
base64 directo en el documento de Firestore — 100% gratis en el plan Spark, sin tarjeta.
Esto alcanza de sobra para probar el sistema y un volumen moderado de uso real; si el
volumen crece mucho (Firestore da 1GB gratis en total), se puede migrar a Storage más
adelante activando Blaze.

## 1. Crear el proyecto de Firebase

1. Entrá a [console.firebase.google.com](https://console.firebase.google.com/) y creá un
   proyecto nuevo (podés desactivar Google Analytics, no hace falta).
2. Dentro del proyecto, click en el ícono **`</>`** ("agregar app web"). Ponele un nombre
   (ej. "validador-fotos") y **no** marques "Firebase Hosting" (usamos GitHub Pages).
3. Te va a mostrar un bloque `firebaseConfig = { apiKey: ..., authDomain: ..., ... }`.
   Copiá esos valores en [firebase-config.js](firebase-config.js), reemplazando cada
   `"REEMPLAZAR..."`.

## 2. Activar Authentication

En el menú lateral, **Authentication > Sign-in method**, activá:

- **Anónimo** — lo usa `index.html` para que cada cliente tenga un `uid` sin pedirle
  registro.
- **Correo electrónico/contraseña** — lo usa `admin.html` para el login del staff.

## 3. Crear Firestore Database

1. **Firestore Database > Crear base de datos**, modo producción, elegí una región
   cercana (ej. `southamerica-east1`).
2. Pestaña **Reglas**: reemplazá todo el contenido por el de [firestore.rules](firestore.rules)
   de este repo y publicá. (No hay Firebase CLI instalada en esta máquina para hacer
   `firebase deploy`, así que las reglas se pegan a mano cada vez que cambian.)

## 4. Crear el primer usuario admin

1. **Authentication > Users > Add user**: cargá el email/contraseña de la primera persona
   que va a usar `admin.html`. Copiá el **User UID** que te muestra la tabla.
2. **Firestore Database > Datos**: creá una colección llamada `admins`. Dentro, creá un
   documento cuyo **ID sea exactamente ese UID** (el contenido del documento puede quedar
   vacío, o con un campo `email` de referencia). Sin este documento, esa cuenta puede
   loguearse en `admin.html` pero va a ver "No autorizado".
3. Repetí el paso para cada persona del staff que necesite acceso al panel.

## 5. Completar datos del negocio

En [firebase-config.js](firebase-config.js):

- `WHATSAPP_NUMERO`: número de WhatsApp al que el cliente manda la captura del ticket,
  en formato internacional sin `+` ni espacios (ej. `5491122334455`).
- `MAX_FOTOS`: cuántas fotos como máximo puede sacar el cliente (por defecto 20).

## 6. Probar en local

Los navegadores exigen un "contexto seguro" (HTTPS o `localhost`) para dar acceso a
cámara y GPS — no funciona abriendo el archivo `index.html` directo con doble click
(`file://`). En esta máquina no hay Python ni Node instalados de verdad (los accesos
directos de `python`/`node` son solo los stubs de la Microsoft Store), así que para
levantar un servidor local hay dos opciones:

- **Extensión "Live Server" de VS Code** (la más simple): instalarla desde el
  Marketplace, click derecho sobre `index.html` > "Open with Live Server".
- **Instalar Python o Node de verdad** y usar `python -m http.server 8000` o
  `npx serve`.

Con cualquiera de las dos, abrir `http://localhost:<puerto>/` en el navegador. Desde el
celular, conectado a la misma red, se puede probar con la IP de la compu
(`http://192.168.x.x:<puerto>/`), pero ahí el navegador **sí** va a pedir HTTPS real para
cámara/ubicación — para probar desde el celular es más simple hacerlo directo contra la
URL pública de GitHub Pages una vez publicado.

## 7. Publicar en GitHub Pages

Este repo se descargó como ZIP (no había `git` instalado en esta máquina). Para subir los
cambios:

- **Opción simple:** entrar a la página del repo en github.com, "Add file > Upload
  files", y arrastrar los archivos modificados/nuevos (`index.html`, `admin.html`,
  `analizador.html`, `shared.css`, `firebase-config.js`).
- **Opción con git:** instalar [Git for Windows](https://git-scm.com/download/win),
  clonar el repo, copiar estos archivos adentro, `git add`, `git commit`, `git push`.

GitHub Pages ya sirve el repo en `https://pxec-py.github.io/Validador_fotos/`, así que
apenas se suben los cambios quedan publicados ahí (HTTPS real, sin restricciones de
cámara/GPS).
