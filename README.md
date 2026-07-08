# Nouts

App auto-hospedada tipo Notion para [Umbrel](https://umbrel.com): páginas con editor
visual (menú `/` de bloques) que guardan **markdown puro**, compartibles con un
**link público de solo lectura** cuyos cambios se ven **en vivo** (SSE).

Las páginas se pueden organizar en **carpetas** (colapsables, con renombrado y
borrado seguro: las páginas nunca se pierden, pasan a la raíz) y **reordenar** con
las flechas ↑/↓ del menú lateral. El editor soporta **casillas de tarea** con el
atajo `[]` estilo Notion además de la sintaxis `- [ ] `.

Los links compartidos tienen **slug editable** (`/s/mi-pagina` en vez de un token
aleatorio) y **contraseña opcional**: el visitante la introduce una vez y queda
autorizado con una cookie firmada (HMAC con secreto por instalación, hash scrypt);
cambiar la contraseña o el slug invalida los accesos anteriores al instante.

- **Editor**: [Milkdown Crepe](https://milkdown.dev) (WYSIWYG markdown).
- **Backend**: Node 22 + Express + SQLite (`better-sqlite3`, WAL) en `/data`.
- **Tiempo real**: Server-Sent Events con heartbeat cada 25 s (atraviesa reverse
  proxies sin configuración especial).
- **Auth**: el editor queda detrás del login de Umbrel (`app_proxy`); solo las
  rutas `/s/*` y `/api/public/*` son públicas (`PROXY_AUTH_WHITELIST`).

## Desarrollo

```sh
npm install
npm run dev          # servidor en :3000 (API) + Vite en :5173 (frontend)
```

En desarrollo abre `http://localhost:5173`. `DATA_DIR` por defecto es `/data`;
para desarrollo exporta p. ej. `DATA_DIR=./data`.

## Ejecutar con Docker (fuera de Umbrel)

```sh
docker compose up -d --build
# http://localhost:3000
```

Los datos persisten en `./data` (SQLite).

## Publicar la imagen multi-arch

```sh
docker login ghcr.io
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/miniweed/nouts:<versión> --push .
docker buildx imagetools inspect ghcr.io/miniweed/nouts:<versión>   # copia el digest
```

Después actualiza `umbrel/miniweed-nouts/docker-compose.yml` con
`ghcr.io/miniweed/nouts:<versión>@sha256:<digest>`. La imagen debe ser pública
(en GitHub: Package settings → Change visibility → Public).

## Instalar en Umbrel

Opción A — community app store: copia `umbrel/miniweed-nouts/` al repositorio
[miniweed/umbrel-app-store](https://github.com/miniweed/umbrel-app-store) (el id
de la app lleva el prefijo `miniweed-` porque ese store tiene `id: miniweed`) y
añade el store en umbrelOS → App Store → ⋮ → Community App Stores si no lo está ya.

Opción B — copia directa para probar (según la skill `umbrel-test-app`):

```sh
rsync -av --delete --exclude=".gitkeep" \
  umbrel/miniweed-nouts/ \
  umbrel@umbrel.local:/home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/miniweed-nouts/
ssh umbrel@umbrel.local "umbreld client apps.install.mutate --appId miniweed-nouts"
```

La app queda en `http://umbrel.local:8748`.

## Exponer a internet (reverse proxy / túnel)

La app está pensada para vivir detrás de cualquier reverse proxy (Caddy, nginx,
Cloudflare Tunnel, [miniweed-tunnel](https://github.com/miniweed/umbrel-app-store)…):

- Apunta el proxy/túnel al puerto **8748** del Umbrel (el puerto del `app_proxy`).
- Los links compartidos se construyen con el dominio con el que se accede
  (`window.location.origin`), así que funcionan con cualquier dominio sin configurar
  nada.
- El editor sigue protegido por el login de Umbrel también en remoto; solo
  `/s/<token>` es público.
- SSE no necesita configuración extra en Caddy; en nginx desactiva el buffering
  (`proxy_buffering off;`) para las rutas `/api/public/*`.

## API

| Ruta | Método | Auth | Descripción |
| --- | --- | --- | --- |
| `/api/pages` | GET/POST | Umbrel | Listar / crear páginas |
| `/api/pages/:id` | GET/PUT/DELETE | Umbrel | Leer / editar / mover de carpeta / borrar |
| `/api/pages/:id/reorder` | POST | Umbrel | Subir/bajar en su ámbito (`{direction}`) |
| `/api/export` | GET | Umbrel | Descargar un .zip con todas las páginas (.md) e imágenes |
| `/api/import` | POST | Umbrel | Restaurar desde un .zip exportado (no destructivo) |
| `/api/folders` | GET/POST | Umbrel | Listar / crear carpetas |
| `/api/folders/:id` | PUT/DELETE | Umbrel | Renombrar / borrar (páginas pasan a raíz) |
| `/api/pages/:id/share` | POST/DELETE | Umbrel | Crear-rotar / revocar link |
| `/api/pages/:id/share` | PUT | Umbrel | Editar slug y/o contraseña (`{slug?, password?}`) |
| `/api/public/:token` | GET | pública | JSON de la página compartida (401 si protegida) |
| `/api/public/:token/unlock` | POST | pública | Desbloquear con contraseña (cookie firmada) |
| `/api/uploads` | POST | Umbrel | Subir una imagen (cuerpo binario, tipo en Content-Type) |
| `/uploads/:file` | GET | pública | Servir imagen subida (id aleatorio, cacheable) |
| `/api/public/:token/events` | GET | pública | SSE con cambios en vivo |
| `/s/:token` | GET | pública | Vista compartida |
| `/api/health` | GET | Umbrel | Healthcheck |
