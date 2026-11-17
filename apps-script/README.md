# Instalación en tu cuenta de Google (una sola vez, ~10 minutos)

Hacelo con la cuenta de Google donde querés que queden las fotos (la de los 200 GB).

## 1. Crear la planilla

1. Entrá a [sheets.new](https://sheets.new). Se abre una planilla nueva.
2. Ponele de nombre **Validador de fotos – Lotes** (arriba a la izquierda).

## 2. Pegar el código

1. En la planilla: menú **Extensiones > Apps Script**. Se abre el editor en otra pestaña.
2. A la izquierda vas a ver `Código.gs`. Borrá todo su contenido y pegá **todo** el
   contenido de [`Codigo.gs`](Codigo.gs) de este repo.
3. Botón **+** al lado de "Archivos" > **HTML** > nombre: `Panel` (sin `.html`).
   Borrá su contenido y pegá **todo** el contenido de [`Panel.html`](Panel.html).
4. Guardá (ícono de disquete o Ctrl+S). Arriba, ponele de nombre al proyecto
   "Validador de fotos".

## 3. Configurar

1. En el editor, en el desplegable de funciones (arriba, al lado de "Depurar") elegí
   **`configurar`** y tocá **Ejecutar**.
2. Google te pide permisos: **Revisar permisos** > elegí tu cuenta > aparece "Google no
   verificó esta app" > **Configuración avanzada** > **Ir a Validador de fotos (no
   seguro)** > **Permitir**. (Es normal: la app es tuya y no está publicada en la tienda
   de Google. Pide acceso a tu Drive y a esta planilla porque ahí guarda las fotos.)
3. Volvé a la planilla: ahora tiene las hojas **Lotes** y **Fotos**, y en tu Drive
   apareció la carpeta **Validador de fotos**.

## 4. Publicar el receptor

1. En el editor de Apps Script: **Implementar > Nueva implementación**.
2. Ícono de engranaje > **Aplicación web**.
3. Completá:
   - Descripción: `v1`
   - **Ejecutar como: Yo** (tu cuenta — así las fotos se guardan en tu Drive)
   - **Quién tiene acceso: Cualquier usuario** (los brokers no tienen cuenta; el código
     solo les permite crear lotes y subir fotos, nunca leer nada)
4. **Implementar**. Copiá la **URL de la aplicación web** (termina en `/exec`).
5. Pasame esa URL (o pegala vos en `APPS_SCRIPT_URL` dentro de [`../config.js`](../config.js))
   y se publica el sitio.

## 5. Crear tu usuario del panel admin

1. Abrí la planilla (recargala si no ves el menú **Validador**).
2. **Validador > Crear o cambiar usuario admin**: elegí un usuario (ej. `francesco`) y una
   contraseña de **al menos 12 caracteres**.
3. Entrá a **https://pxec-py.github.io/Validador_fotos/admin.html** con ese usuario.

Repetí para cada persona que revise. Para quitarle el acceso a alguien:
**Validador > Borrar usuario admin** (sus sesiones abiertas se cortan).

## 6. (Alternativa) Panel dentro de la planilla

1. Abrí la planilla. Si no ves el menú **Validador**, recargá la página.
2. En la hoja **Lotes**, hacé click en cualquier celda de un lote.
3. **Validador > Ver fotos del lote seleccionado**: se abre un panel a la derecha con los
   datos, el mapa, las miniaturas (click = foto original en Drive) y los botones
   **Aprobar / Rechazar** con nota.
4. Para descargar todas las fotos de un lote: "Abrir carpeta" > en Drive, click derecho
   sobre la carpeta > **Descargar** (Drive arma el ZIP con los originales).

También podés filtrar la hoja **Lotes** por estado, agente o patente con los filtros
normales de Sheets.

## Si cambiás el código más adelante (actualizaciones)

Pegás el código nuevo y vas a **Implementar > Gestionar implementaciones > (lápiz) >
Versión: Nueva versión > Implementar**. Así la URL `/exec` **no cambia** y no hay que
tocar el sitio.

## Seguridad de la cuenta

- Activá la **verificación en dos pasos** en esa cuenta de Google.
- No compartas la planilla ni la carpeta "Validador de fotos" fuera del equipo que revisa.
  Si alguien más tiene que revisar, compartile la planilla como **Editor**: va a ver el
  menú Validador con su propia cuenta.
