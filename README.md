# Validador de fotos

Sitio estático (sin backend propio) que usa **Firebase** (Auth + Firestore) como base de
datos y **Cloudinary** para alojar las fotos. Tres páginas:

- `index.html` + `index.js` — el **agente / broker** indica su nombre (obligatorio) y la
  patente (opcional), confirma su ubicación (GPS del dispositivo, no editable a mano) y saca
  hasta 20 fotos del vehículo desde la cámara del navegador. Las fotos se guardan en
  **máxima calidad**: resolución nativa del sensor (vía `ImageCapture.takePhoto()` en
  Android/Chrome, o el cuadro de video 4K en iPhone), hasta 4096 px de lado mayor y JPEG
  0.95. Cada foto queda con un **código QR quemado en la imagen** (`TICKET-NN`) generado
  con la librería [`qrcode`](https://github.com/soldair/node-qrcode). La subida muestra
  progreso por foto, reintenta sola ante cortes de red y, si igual falla, ofrece
  "Reintentar subida" sin duplicar lo ya subido. Al final muestra el **código de ticket**
  para mandar por WhatsApp.
- `admin.html` + `admin.js` — panel de administración: buscar un lote por ticket, patente o agente, revisar fotos +
  ubicación, aprobar o rechazar, exportar el lote aprobado como ZIP **con los originales en máxima calidad**, y **escanear el QR**
  de una foto con la cámara del dispositivo (librería [`jsQR`](https://github.com/cozmo/jsQR))
  para contrastarla contra la fecha/hora y ubicación reales guardadas en Firestore — si
  alguien reusa o falsifica una foto, el escaneo no va a coincidir con ningún registro
  válido.
- `analizador.html` — el analizador forense de metadatos (100% local, con CSP que impide enviar datos afuera), útil
  para revisar a mano la captura de WhatsApp que manda el cliente.

No hay paso de build: son archivos HTML/CSS/JS planos que se sirven tal cual (GitHub
Pages, o cualquier hosting estático).

**Nota sobre las fotos:** no usamos Firebase Storage a propósito, porque desde fines de
2024 exige activar el plan de pago Blaze (con tarjeta) incluso para uso gratuito. Tampoco
las guardamos en Firestore como texto (eso limitaba mucho la calidad, por el tope de 1MB
por documento). Las fotos se suben directo del navegador a **Cloudinary** — plan gratuito
generoso, sin pedir tarjeta — usando un "unsigned upload preset" (no expone ninguna clave
secreta). Firestore solo guarda el link a cada foto.

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

## 4. Crear la cuenta de Cloudinary

1. Entrá a [cloudinary.com](https://cloudinary.com/) y creá una cuenta gratuita (no pide
   tarjeta).
2. En el **Dashboard**, copiá el valor de **"Cloud name"** — va en
   `CLOUDINARY_CLOUD_NAME` dentro de [firebase-config.js](firebase-config.js).
3. Andá a **Settings** (ícono de engranaje) **> Upload > Upload presets > Add upload
   preset**:
   - **Signing Mode**: `Unsigned` (imprescindible — así se puede subir desde el navegador
     sin exponer ninguna clave secreta).
   - **Endurecer el preset (importante, el repo es público):**
     - *Folder*: `validador` (todas las fotos quedan juntas).
     - *Allowed formats*: `jpg`.
     - *Max file size*: 10 MB (tope del plan gratuito).
     - *Unique filename*: activado. *Overwrite*: desactivado. *Use filename*: desactivado.
     - *Return delete token*: desactivado.
     - **No** configurar "Incoming transformation" ni calidad automática: se perdería la
       calidad original de la foto.
   - Guardá y copiá el **nombre del preset** — va en `CLOUDINARY_UPLOAD_PRESET` en
     [firebase-config.js](firebase-config.js).
4. Si cambiás de cuenta de Cloudinary, actualizá también la regex de `url` en
   [firestore.rules](firestore.rules) (hoy acepta solo `res.cloudinary.com/vikwio2u/...`).

## 5. Crear el primer usuario admin

1. **Authentication > Users > Add user**: cargá el email/contraseña de la primera persona
   que va a usar `admin.html`. Copiá el **User UID** que te muestra la tabla.
2. **Firestore Database > Datos**: creá una colección llamada `admins`. Dentro, creá un
   documento cuyo **ID sea exactamente ese UID** (el contenido del documento puede quedar
   vacío, o con un campo `email` de referencia). Sin este documento, esa cuenta puede
   loguearse en `admin.html` pero va a ver "No autorizado".
3. Repetí el paso para cada persona del staff que necesite acceso al panel.

## 6. Completar datos del negocio

En [firebase-config.js](firebase-config.js):

- `MAX_FOTOS`: cuántas fotos como máximo puede sacar el cliente (por defecto 20).

El botón "Enviar por WhatsApp" de la pantalla de ticket usa `wa.me` sin número fijo
(`https://wa.me/?text=...`): abre WhatsApp y el cliente elige a quién mandárselo, así que
no hace falta configurar ningún número acá.

## 7. Probar en local

Los navegadores exigen un "contexto seguro" (HTTPS o `localhost`) para dar acceso a
cámara y GPS — no funciona abriendo `index.html` con doble click (`file://`). Desde la
carpeta del proyecto:

```
python -m http.server 8000 --bind 127.0.0.1
```

y abrir `http://localhost:8000/`. (Kaspersky inyecta un script en las páginas `http://`
locales y la consola muestra avisos de CSP por eso: no afecta y no pasa en GitHub Pages.)
Para probar desde el celular conviene usar directamente la URL de GitHub Pages (HTTPS).

## 8. Publicar en GitHub Pages

1. En GitHub: **Settings > General > Danger Zone > Change visibility > Public** (GitHub
   Pages gratis requiere repo público).
2. **Settings > Pages**: *Source* = "Deploy from a branch", *Branch* = `main` / `(root)`.
3. En 1–2 minutos queda en `https://pxec-py.github.io/Validador_fotos/`.

Para publicar cambios: `git add -A`, `git commit -m "..."`, `git push origin main`.

## 9. Seguridad (OWASP Top 10) — qué está hecho y qué falta configurar

El sitio es estático y el repo es público: **nada en el código es secreto** (la config web
de Firebase y el nombre del preset de Cloudinary están pensados para ser públicos). La
seguridad real está en las **reglas de Firestore**, la configuración de las consolas y en
cómo se pinta la información.

| OWASP | Riesgo | Qué se hizo |
|---|---|---|
| A01 Control de acceso | Leer/modificar lotes ajenos | Reglas: solo el dueño o un admin leen; solo admin revisa y solo los campos de revisión; nada se borra; fotos solo mientras el lote está pendiente y dentro de las 2 h. |
| A02 Fallas criptográficas | Ticket adivinable | Ticket con `crypto.getRandomValues` sin sesgo. Todo por HTTPS. |
| A03 Inyección / XSS | Un broker carga `<script>` en la patente y se ejecuta en el panel admin | Todo dato de Firestore o de un QR se escapa (`esc()` / `textContent`). Las URLs de fotos solo se usan si son de nuestra cuenta de Cloudinary. |
| A04 Diseño inseguro | Escribir cualquier campo / URL a sitios de terceros | Reglas validan el esquema completo (campos permitidos, tipos, largos, regex de ticket, patente y URL). |
| A05 Configuración | Sin CSP, clickjacking | CSP estricta sin `unsafe-inline` para scripts (todo el JS está en archivos `.js`), `object-src 'none'`, bloqueo de iframes, `noindex` y `no-referrer` en el admin. El analizador tiene `connect-src 'none'`: el navegador garantiza que no envía nada. |
| A06 Componentes | Librerías con fallas | Versiones fijas de Firebase (10.14.1), qrcode, jszip y jsQR. |
| A07 Autenticación | Sesiones eternas en el admin | Sesión solo de pestaña + cierre automático a los 30 min sin actividad; mensajes de login genéricos; un usuario anónimo nunca entra al panel. |
| A08 Integridad | CDN comprometido | Subresource Integrity (`integrity=sha384-...`) en todos los scripts de jsDelivr. |
| A09 Registro | — | Cada lote guarda `creatorUid`, user-agent, `revisadoPor` y `revisadoAt`. |
| A10 SSRF | — | No aplica (no hay servidor propio). |

**Pendiente en las consolas (no se puede hacer desde el código):**

1. **Pegar las reglas nuevas** de [firestore.rules](firestore.rules) en Firestore > Reglas
   (sin esto, la versión nueva del sitio no puede guardar el campo "agente").
2. **Restringir la API key** de Firebase: Google Cloud Console > APIs y servicios >
   Credenciales > la "Browser key" > *Restricciones de aplicación* = Sitios web (HTTP
   referrers): `https://pxec-py.github.io/*` y `http://localhost:8000/*`.
3. **Authentication > Settings**: activar *Email enumeration protection*. **No** desactivar
   "Enable create (sign-up)": eso también corta el login anónimo de los brokers. No hace
   falta: una cuenta creada por terceros no ve nada sin su documento en `admins`.
4. **Authentication > Settings > Authorized domains**: dejar solo `localhost` y
   `pxec-py.github.io`.
5. **App Check** (recomendado): Firebase > App Check > registrar la app web con reCAPTCHA
   Enterprise y "Enforce" en Firestore — frena bots que usen el login anónimo para
   llenar la base.
6. **Endurecer el preset de Cloudinary** (ver paso 4).

**Riesgos residuales conocidos (asumidos por ser un sitio sin backend):**

- El preset de Cloudinary es *unsigned*: cualquiera que lo lea en el código puede subir
  imágenes a la cuenta (no puede borrar ni pisar). Se mitiga con el endurecimiento del
  preset; eliminarlo del todo requiere firmar las subidas con un backend (Cloud Functions
  exige plan Blaze).
- Las URLs de Cloudinary son públicas: quien tenga el link exacto ve la foto. Los links
  son aleatorios y solo los ven el broker que subió y los admins.
- La ubicación y la hora salen del dispositivo: un usuario con herramientas de desarrollo
  podría falsearlas. El QR, la hora del servidor (`createdAt`) y el analizador forense son
  los controles cruzados.
- GitHub Pages no permite headers HTTP propios (HSTS, `frame-ancestors`): se cubren con
  la CSP en `<meta>` y el bloqueo de iframes por JS.
