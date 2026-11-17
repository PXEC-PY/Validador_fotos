# Validador de fotografías

Sistema para que **agentes / brokers** carguen hasta 20 fotografías de cualquier bien
(vehículos, locales, maquinarias…) en **máxima calidad**,
con GPS y un código QR anti-fraude quemado en cada foto. **Todo se guarda en una cuenta de
Google propia** (Drive + Planilla): no hay Firebase, Cloudinary ni servidores de terceros
que guarden datos.

```
Celular del broker                      Tu cuenta de Google
(GitHub Pages: solo sirve la página)    ┌────────────────────────────────────────┐
  index.html + index.js  ── HTTPS ───▶  │ Apps Script (apps-script/Codigo.gs)    │
    · cámara a resolución nativa        │   valida todo y guarda:                │
    · GPS del dispositivo               │   · Drive: Validador de fotos/         │
    · QR TICKET-NN en cada foto         │       AAAA-MM/TICKET/TICKET-NN.jpg     │
                                        │   · Planilla: hojas "Lotes" y "Fotos"  │
                                        │ Panel admin = menú "Validador" de la   │
                                        │   Planilla (protegido por tu login)    │
                                        └────────────────────────────────────────┘
```

- `index.html` + `index.js` — la persona indica su nombre o agencia (obligatorio) y una
  referencia libre del bien (chapa, dirección, póliza; opcional), confirma su ubicación (GPS, no editable) y saca hasta 20 fotos con la
  cámara del navegador. Se capturan a **resolución nativa** (`ImageCapture.takePhoto()`
  en Android, cuadro 4K en iPhone), hasta 4096 px y JPEG 0.95, con el QR `TICKET-NN`
  quemado. La subida muestra progreso, reintenta sola y permite "Reintentar subida" sin
  duplicar fotos.
- `admin.html` + `admin.js` — **panel admin** (`https://pxec-py.github.io/Validador_fotos/admin.html`):
  usuario y contraseña propios, lista de lotes con búsqueda y filtros, miniaturas, foto
  original en máxima calidad, aprobar/rechazar con nota, ZIP con los originales y
  **escáner del QR** de una foto para verificarla contra la base. Los usuarios se crean
  desde la Planilla: **Validador > Crear o cambiar usuario admin**.
- `config.js` — URL del Apps Script y parámetros de calidad.
- `apps-script/` — el código que va dentro de tu cuenta de Google (receptor + panel
  admin). **Instalación paso a paso: [apps-script/README.md](apps-script/README.md).**
- `analizador.html` — analizador forense de metadatos, 100% local (su CSP impide que
  envíe datos a cualquier lado).

No hay paso de build: son archivos HTML/CSS/JS planos.

## Costos y espacio

Gratis. Las fotos ocupan el espacio de la cuenta de Google que elijas (con 200 GB entran
unos 2.500 lotes de 20 fotos en máxima calidad). Apps Script no cobra; sus cuotas diarias
sobran para este uso.

## Probar en local

Cámara y GPS solo funcionan en HTTPS o `localhost`:

```
python -m http.server 8000 --bind 127.0.0.1
```

y abrir `http://localhost:8000/`. (Kaspersky inyecta un script en las páginas `http://`
locales y la consola muestra avisos de CSP por eso: no afecta y no pasa en GitHub Pages.)

## Publicar

GitHub Pages sirve la rama `main` en `https://pxec-py.github.io/Validador_fotos/`.
Para publicar cambios: `git add -A`, `git commit -m "..."`, `git push origin main`.

## Seguridad (OWASP Top 10)

El repo es público: **nada en el código es secreto**. La URL del Apps Script es pública
a propósito (los brokers no tienen cuenta); toda la seguridad está del lado de Google.

| OWASP | Riesgo | Qué se hizo |
|---|---|---|
| A01 Control de acceso | Ver o tocar lotes ajenos | Sin sesión, el endpoint **solo puede crear lotes y agregar fotos** (con el token de ese lote). Leer, ver fotos, revisar y verificar QR exige sesión de admin válida. |
| A02 Criptografía | Ticket adivinable / subir a lotes ajenos | Ticket y **token secreto por lote** generados en el servidor (aleatorio seguro). En la planilla se guarda solo el hash SHA-256 del token; comparación en tiempo constante. |
| A03 Inyección | XSS en el panel, fórmulas en la planilla, archivos maliciosos | El panel pinta todo con `textContent`. Los textos que empiezan con `= + - @` se neutralizan (inyección de fórmulas en Sheets). Solo se aceptan **JPEG reales** (se revisan los bytes) y el nombre del archivo lo arma el servidor. |
| A04 Diseño | Abuso / DoS / llenar el Drive | Máx. 20 fotos y 15 MB por foto, solo con el lote pendiente y dentro de las 2 h. Topes globales: 40 lotes por hora, 200 lotes y 5 GB por día (ajustables en `CONFIG` de Codigo.gs); el panel admin muestra el uso del día. Sin login no se puede limitar por persona (Apps Script no recibe la IP): eso queda para cuando haya login de agentes. |
| A05 Configuración | Clickjacking, scripts inyectados | CSP estricta sin scripts inline que solo permite **los 3 archivos exactos** de librerías (no todo jsDelivr), `object-src 'none'`, bloqueo de iframes, `noindex` en el admin. |
| A06 Componentes | Librerías con fallas | Versiones fijas de qrcode y jszip. |
| A07 Autenticación | Fuerza bruta, sesiones eternas | Contraseñas de admin con sal + 3000 rondas HMAC-SHA256 (nunca en texto plano, mínimo 12 caracteres); bloqueo 15 min tras 5 fallos y tope global por hora; mismo mensaje para usuario o clave incorrectos; sesión aleatoria de 256 bits que vence a los 30 min sin uso (máx. 8 h) y vive solo en la pestaña. La Planilla sigue protegida por el login de Google (activá verificación en dos pasos). |
| A08 Integridad | CDN comprometido | Subresource Integrity (`sha384`) en los scripts de jsDelivr. |
| A09 Registro | Trazabilidad | Cada lote guarda hora del servidor, user-agent, quién revisó y cuándo; cada foto, su SHA-256 (cadena de custodia). |
| A10 SSRF | — | No aplica: el servidor no descarga URLs. |

**Riesgos residuales (conocidos y aceptados):**

- **Foto armada por fuera de la página:** alguien con conocimientos técnicos podría usar
  el ticket y el token de *su propio* lote para mandar una imagen editada sin pasar por la
  cámara. El servidor no puede probar que la foto salió del sensor. Controles cruzados:
  hora del servidor vs. hora de la foto, GPS, QR, SHA-256 y el analizador forense.
- **Bloqueo del login como molestia:** 5 intentos fallidos bloquean ese usuario 15 min, y
  30 fallidos en una hora bloquean el login para todos durante esa hora. Protege contra
  fuerza bruta a costa de que alguien pueda molestar a propósito.
- **Hash de contraseñas:** 3000 rondas de HMAC-SHA256 (Apps Script no tiene bcrypt/argon2
  y cada ronda cuesta tiempo de ejecución). Las contraseñas solo están en las propiedades
  del script, visibles únicamente para la cuenta dueña. Usá contraseñas largas y únicas.

- Cualquiera que lea la URL del Apps Script puede **crear lotes vacíos** (no puede ver
  nada). Mitigado con los topes por hora y por día; si molesta, se borran filas.
- **Servicios viejos:** el proyecto de Firebase y el preset de Cloudinary que se usaban
  antes siguen existiendo en esas cuentas. Conviene borrarlos (ver más abajo).
- La ubicación y la hora de captura salen del celular; la hora de recepción y de creación
  del lote las pone el servidor. El QR y el analizador forense son controles cruzados.
- Los datos son de clientes de una aseguradora: conviene usar una cuenta de Google de la
  empresa (o una cuenta dedicada) con verificación en dos pasos, y no compartir la
  carpeta ni la planilla con nadie fuera del equipo de revisión.

### Limpieza pendiente de la versión anterior

1. **Firebase** (`validador-fotos-44f0a`): Firebase Console > Configuración del proyecto >
   *Eliminar proyecto* (o al menos Firestore > Reglas: `allow read, write: if false;`).
2. **Cloudinary**: Settings > Upload > Upload presets > borrar el preset *unsigned*, y
   Media Library > borrar las fotos de prueba (sus links son públicos).
