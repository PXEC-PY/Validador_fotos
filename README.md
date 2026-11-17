# Validador de fotos

Sistema para que **agentes / brokers** carguen fotos de vehículos en **máxima calidad**,
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

- `index.html` + `index.js` — el broker indica su nombre (obligatorio) y la patente
  (opcional), confirma su ubicación (GPS, no editable) y saca hasta 20 fotos con la
  cámara del navegador. Se capturan a **resolución nativa** (`ImageCapture.takePhoto()`
  en Android, cuadro 4K en iPhone), hasta 4096 px y JPEG 0.95, con el QR `TICKET-NN`
  quemado. La subida muestra progreso, reintenta sola y permite "Reintentar subida" sin
  duplicar fotos.
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
| A01 Control de acceso | Ver o tocar lotes ajenos | El endpoint público **solo puede crear lotes y agregar fotos**; no tiene ninguna función para leer o listar. Leer, revisar y aprobar se hace solo desde la Planilla, con tu login de Google. |
| A02 Criptografía | Ticket adivinable / subir a lotes ajenos | Ticket y **token secreto por lote** generados en el servidor (aleatorio seguro). En la planilla se guarda solo el hash SHA-256 del token; comparación en tiempo constante. |
| A03 Inyección | XSS en el panel, fórmulas en la planilla, archivos maliciosos | El panel pinta todo con `textContent`. Los textos que empiezan con `= + - @` se neutralizan (inyección de fórmulas en Sheets). Solo se aceptan **JPEG reales** (se revisan los bytes) y el nombre del archivo lo arma el servidor. |
| A04 Diseño | Abuso / llenar el Drive | Máx. 20 fotos y 15 MB por foto, solo con el lote pendiente y dentro de las 2 h; tope global de 120 lotes por hora. |
| A05 Configuración | Clickjacking, scripts inyectados | CSP estricta sin scripts inline, `object-src 'none'`, bloqueo de iframes. |
| A06 Componentes | Librerías con fallas | Versiones fijas de qrcode y jszip. |
| A07 Autenticación | — | No hay contraseñas propias: el admin usa la autenticación de Google (activá la verificación en dos pasos en esa cuenta). |
| A08 Integridad | CDN comprometido | Subresource Integrity (`sha384`) en los scripts de jsDelivr. |
| A09 Registro | Trazabilidad | Cada lote guarda hora del servidor, user-agent, quién revisó y cuándo; cada foto, su SHA-256 (cadena de custodia). |
| A10 SSRF | — | No aplica: el servidor no descarga URLs. |

**Riesgos residuales:**

- Cualquiera que lea la URL del Apps Script puede **crear lotes vacíos** (no puede ver
  nada). Mitigado con el tope por hora; si molesta, se borran filas en la planilla.
- La ubicación y la hora de captura salen del celular; la hora de recepción y de creación
  del lote las pone el servidor. El QR y el analizador forense son controles cruzados.
- Los datos son de clientes de una aseguradora: conviene usar una cuenta de Google de la
  empresa (o una cuenta dedicada) con verificación en dos pasos, y no compartir la
  carpeta ni la planilla con nadie fuera del equipo de revisión.
