import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import JSZip from "jszip";
import {
  folders,
  getMeta,
  pages,
  purgeTrashOlderThan,
  setMeta,
  type Page,
} from "./db.js";
import { publish, subscribe, type PageEvent } from "./events.js";
import {
  clearUnlockAttempts,
  grantShareAccess,
  hasShareAccess,
  hashPassword,
  rateLimitUnlock,
  verifyPassword,
} from "./shareAuth.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || "/data";
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Tipos de imagen aceptados en la subida (sin SVG: evita XSS al servirlo).
const UPLOAD_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 25_000;
// Topes de conexiones SSE para que un visitante no agote el contenedor.
// Detrás de un túnel muchos visitantes comparten la IP de salida del VPS, por
// eso el tope global es la protección principal y el de por-IP es holgado.
const SSE_MAX_TOTAL = 300;
const SSE_MAX_PER_IP = 50;
let sseOpen = 0;
const ssePerIp = new Map<string, number>();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// En la imagen Docker el build de Vite se copia a server/dist/public;
// en desarrollo Vite sirve el frontend y aquí solo vive la API.
const WEB_DIST = process.env.WEB_DIST || path.join(__dirname, "public");

const app = express();
// Un solo salto de confianza: el app_proxy de Umbrel. No confiamos en toda la
// cadena X-Forwarded-For (falsificable), por eso los límites críticos no
// dependen solo de req.ip (ver rateLimitUnlock).
app.set("trust proxy", 1);
app.disable("x-powered-by");

// --- Aislamiento frente a otras apps de Umbrel ---------------------------
// Cualquier contenedor de umbrel_main_network podría llamar directo a este
// servicio saltándose el app_proxy (y su login). Todo el tráfico legítimo
// entra por el proxy, así que exigimos que el par inmediato de la conexión
// (no falsificable con X-Forwarded-For) sea el app_proxy o loopback.
// Modo por defecto "log": no bloquea, solo avisa, hasta confirmar en el
// Umbrel real que la IP del proxy se detecta bien; luego se activa "enforce".
const PROXY_ONLY_MODE = process.env.PROXY_ONLY_MODE || "log"; // off | log | enforce
const APP_PROXY_HOSTNAME = process.env.APP_PROXY_HOSTNAME || "";
let proxyIps = new Set<string>();

async function resolveProxyIps() {
  if (!APP_PROXY_HOSTNAME) return;
  try {
    const addrs = await dns.lookup(APP_PROXY_HOSTNAME, { all: true });
    proxyIps = new Set(addrs.map((a) => a.address.replace(/^::ffff:/, "")));
    console.log(
      `[nouts] app_proxy (${APP_PROXY_HOSTNAME}) → ${[...proxyIps].join(", ")} (modo ${PROXY_ONLY_MODE})`
    );
  } catch {
    console.warn(`[nouts] no se pudo resolver APP_PROXY_HOSTNAME=${APP_PROXY_HOSTNAME}`);
  }
}

app.use((req, res, next) => {
  // Sin IPs resueltas (desarrollo local) o modo off: no filtramos.
  if (PROXY_ONLY_MODE === "off" || proxyIps.size === 0) return next();
  const peer = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (peer === "127.0.0.1" || peer === "::1" || proxyIps.has(peer)) return next();
  if (PROXY_ONLY_MODE === "enforce") return res.status(403).json({ error: "forbidden" });
  console.warn(`[nouts] petición no vía app_proxy (peer=${peer}); en enforce se bloquearía`);
  next();
});

// --- Protección CSRF -----------------------------------------------------
// Las peticiones que mutan estado en la API privada exigen una cabecera
// personalizada que un formulario/navegación cross-site no puede fijar sin
// un preflight CORS (que no respondemos). Las rutas públicas de compartir
// están exentas: tienen su propia protección (token + contraseña + límite).
const CSRF_SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
app.use("/api", (req, res, next) => {
  if (CSRF_SAFE.has(req.method)) return next();
  if (req.path.startsWith("/public/")) return next();
  if (req.headers["x-requested-with"] !== "nouts") {
    return res.status(403).json({ error: "csrf" });
  }
  next();
});

app.use(express.json({ limit: "5mb" }));

// El hash de contraseña nunca sale de la API; el cliente solo ve has_password.
function toClientPage(page: Page) {
  const { share_password_hash, ...rest } = page;
  return { ...rest, has_password: share_password_hash !== null };
}

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/;

// ---------- API privada (protegida por el app_proxy de Umbrel) ----------

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/pages", (_req, res) => {
  res.json(pages.list());
});

app.post("/api/pages", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title : "";
  const folderId = typeof req.body?.folder_id === "string" ? req.body.folder_id : null;
  if (folderId && !folders.get(folderId)) {
    return res.status(400).json({ error: "invalid_folder" });
  }
  const page = pages.create(title, folderId);
  res.status(201).json(toClientPage(page));
});

app.get("/api/pages/:id", (req, res) => {
  const page = pages.get(req.params.id);
  if (!page) return res.status(404).json({ error: "not_found" });
  res.json(toClientPage(page));
});

app.put("/api/pages/:id", (req, res) => {
  if (req.body?.folder_id !== undefined) {
    const folderId = req.body.folder_id;
    if (folderId !== null && (typeof folderId !== "string" || !folders.get(folderId))) {
      return res.status(400).json({ error: "invalid_folder" });
    }
    if (!pages.get(req.params.id)) return res.status(404).json({ error: "not_found" });
    pages.setFolder(req.params.id, folderId);
  }
  const fields: { title?: string; content?: string } = {};
  if (typeof req.body?.title === "string") fields.title = req.body.title;
  if (typeof req.body?.content === "string") fields.content = req.body.content;
  if (Object.keys(fields).length === 0) {
    // Solo movimiento de carpeta: no toca updated_at ni notifica espectadores.
    const page = pages.get(req.params.id);
    if (!page) return res.status(404).json({ error: "not_found" });
    return res.json(toClientPage(page));
  }
  // Concurrencia optimista: si el cliente envía el updated_at que conocía y ya
  // no coincide, otra pestaña/dispositivo escribió antes → 409 sin pisar.
  const baseUpdatedAt = req.body?.base_updated_at;
  if (typeof baseUpdatedAt === "string") {
    const current = pages.get(req.params.id);
    if (!current) return res.status(404).json({ error: "not_found" });
    if (current.updated_at !== baseUpdatedAt) {
      return res.status(409).json({ error: "conflict", page: toClientPage(current) });
    }
  }
  const page = pages.update(req.params.id, fields);
  if (!page) return res.status(404).json({ error: "not_found" });
  publish(page.id, {
    type: "update",
    title: page.title,
    content: page.content,
    updated_at: page.updated_at,
  });
  res.json(toClientPage(page));
});

app.delete("/api/pages/:id", (req, res) => {
  const existed = pages.delete(req.params.id);
  if (!existed) return res.status(404).json({ error: "not_found" });
  publish(req.params.id, { type: "gone" });
  res.status(204).end();
});

app.post("/api/pages/:id/reorder", (req, res) => {
  const direction = req.body?.direction;
  if (direction !== "up" && direction !== "down") {
    return res.status(400).json({ error: "invalid_direction" });
  }
  if (!pages.get(req.params.id)) return res.status(404).json({ error: "not_found" });
  const moved = pages.reorder(req.params.id, direction);
  res.json({ moved });
});

app.get("/api/folders", (_req, res) => {
  res.json(folders.list());
});

app.post("/api/folders", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "invalid_name" });
  res.status(201).json(folders.create(name));
});

app.put("/api/folders/:id", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "invalid_name" });
  if (!folders.get(req.params.id)) return res.status(404).json({ error: "not_found" });
  res.json(folders.rename(req.params.id, name));
});

app.delete("/api/folders/:id", (req, res) => {
  const existed = folders.delete(req.params.id);
  if (!existed) return res.status(404).json({ error: "not_found" });
  res.status(204).end();
});

app.post("/api/pages/:id/share", (req, res) => {
  const page = pages.get(req.params.id);
  if (!page) return res.status(404).json({ error: "not_found" });
  const token = crypto.randomBytes(16).toString("base64url");
  pages.setShareToken(page.id, token);
  if (page.share_token) publish(page.id, { type: "gone" });
  res.json({ share_token: token });
});

// Edita el link compartido: slug personalizado y/o contraseña.
// body: { slug?: string, password?: string | null }
app.put("/api/pages/:id/share", (req, res) => {
  const page = pages.get(req.params.id);
  if (!page) return res.status(404).json({ error: "not_found" });
  if (!page.share_token) return res.status(409).json({ error: "not_shared" });

  const { slug, password } = req.body ?? {};

  if (slug !== undefined) {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      return res.status(400).json({ error: "invalid_slug" });
    }
    if (slug !== page.share_token) {
      const taken = pages.getByToken(slug);
      if (taken && taken.id !== page.id) {
        return res.status(409).json({ error: "slug_taken" });
      }
      pages.setShareToken(page.id, slug);
      // Los espectadores del link antiguo dejan de tener acceso.
      publish(page.id, { type: "gone" });
    }
  }

  if (password !== undefined) {
    if (password === null || password === "") {
      pages.setSharePassword(page.id, null);
    } else if (typeof password === "string") {
      pages.setSharePassword(page.id, hashPassword(password));
      // Obliga a los espectadores conectados a introducir la contraseña nueva.
      publish(page.id, { type: "reauth" });
    } else {
      return res.status(400).json({ error: "invalid_password" });
    }
  }

  const updated = pages.get(page.id)!;
  res.json({ share_token: updated.share_token, has_password: !!updated.share_password_hash });
});

app.delete("/api/pages/:id/share", (req, res) => {
  const page = pages.get(req.params.id);
  if (!page) return res.status(404).json({ error: "not_found" });
  pages.setShareToken(page.id, null);
  pages.setSharePassword(page.id, null);
  publish(page.id, { type: "gone" });
  res.status(204).end();
});

// ---------- Ajustes (dominio público de los links compartidos) ----------

app.get("/api/settings", (_req, res) => {
  res.json({ public_base_url: getMeta("public_base_url") ?? "" });
});

app.put("/api/settings", (req, res) => {
  const raw = req.body?.public_base_url;
  if (raw === undefined || raw === null || raw === "") {
    setMeta("public_base_url", "");
    return res.json({ public_base_url: "" });
  }
  if (typeof raw !== "string") return res.status(400).json({ error: "invalid_url" });
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return res.status(400).json({ error: "invalid_url" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return res.status(400).json({ error: "invalid_url" });
  }
  // Guardamos origen + ruta sin barra final (ej. https://notas.midominio.com).
  const value = (url.origin + url.pathname).replace(/\/+$/, "");
  setMeta("public_base_url", value);
  res.json({ public_base_url: value });
});

// ---------- Búsqueda de texto (FTS5) ----------

app.get("/api/search", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.json(pages.search(q));
});

// ---------- Papelera (soft-delete) ----------

app.get("/api/trash", (_req, res) => {
  res.json(pages.listTrash());
});

app.post("/api/pages/:id/restore", (req, res) => {
  const page = pages.restore(req.params.id);
  if (!page) return res.status(404).json({ error: "not_found" });
  res.json(toClientPage(page));
});

app.delete("/api/pages/:id/purge", (req, res) => {
  const existed = pages.purge(req.params.id);
  if (!existed) return res.status(404).json({ error: "not_found" });
  res.status(204).end();
});

// ---------- API pública (whitelisted en el app_proxy) ----------

function publicPayload(page: { title: string; content: string; updated_at: string }) {
  return { title: page.title, content: page.content, updated_at: page.updated_at };
}

app.get("/api/public/:token", (req, res) => {
  const page = pages.getByToken(req.params.token);
  if (!page) return res.status(404).json({ error: "not_found" });
  if (!hasShareAccess(req, page)) {
    return res.status(401).json({ error: "password_required" });
  }
  res.json(publicPayload(page));
});

app.post("/api/public/:token/unlock", (req, res) => {
  if (!rateLimitUnlock(req, req.params.token)) {
    return res.status(429).json({ error: "too_many_attempts" });
  }
  const page = pages.getByToken(req.params.token);
  if (!page) return res.status(404).json({ error: "not_found" });
  if (!page.share_password_hash) return res.status(204).end();
  const password = req.body?.password;
  if (typeof password !== "string" || !verifyPassword(password, page.share_password_hash)) {
    return res.status(401).json({ error: "wrong_password" });
  }
  clearUnlockAttempts(req.params.token);
  grantShareAccess(res, page);
  res.status(204).end();
});

app.get("/api/public/:token/events", (req, res) => {
  const page = pages.getByToken(req.params.token);
  if (!page) return res.status(404).json({ error: "not_found" });
  if (!hasShareAccess(req, page)) {
    return res.status(401).json({ error: "password_required" });
  }

  const ip = req.ip ?? "unknown";
  const perIp = ssePerIp.get(ip) ?? 0;
  if (sseOpen >= SSE_MAX_TOTAL || perIp >= SSE_MAX_PER_IP) {
    return res.status(503).json({ error: "too_many_connections" });
  }
  sseOpen++;
  ssePerIp.set(ip, perIp + 1);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: PageEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // gone/reauth cierran el stream: el cliente debe recargar o reautenticarse.
    if (event.type === "gone" || event.type === "reauth") res.end();
  };

  // Estado inicial para que el cliente no dependa de una carrera con el fetch.
  send({ type: "update", ...publicPayload(page) });

  const unsubscribe = subscribe(page.id, send);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    sseOpen--;
    const n = (ssePerIp.get(ip) ?? 1) - 1;
    if (n <= 0) ssePerIp.delete(ip);
    else ssePerIp.set(ip, n);
  });
});

// ---------- Subida de imágenes ----------

// Subida (privada, solo el editor tras el login de Umbrel). El cuerpo es el
// binario de la imagen; el tipo llega en Content-Type. Se guarda con un id
// aleatorio y se devuelve una URL relativa persistente.
app.post("/api/uploads", async (req, res) => {
  const type = (req.headers["content-type"] || "").split(";")[0].trim();
  const ext = UPLOAD_TYPES[type];
  if (!ext) return res.status(415).json({ error: "unsupported_type" });

  const filename = `${crypto.randomBytes(16).toString("base64url")}.${ext}`;
  const dest = path.join(UPLOADS_DIR, filename);

  let size = 0;
  let tooBig = false;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES && !tooBig) {
      tooBig = true;
      req.destroy();
    }
  });

  try {
    await pipeline(req, fs.createWriteStream(dest));
  } catch {
    fs.rm(dest, () => {});
    return res
      .status(tooBig ? 413 : 400)
      .json({ error: tooBig ? "too_large" : "upload_failed" });
  }
  res.json({ url: `/uploads/${filename}` });
});

// Servir imágenes (público, whitelisted): quien abre un link compartido debe
// poder cargarlas. El id aleatorio hace la URL no adivinable, como el token.
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    immutable: true,
    maxAge: "365d",
    index: false,
    setHeaders(res) {
      // Un archivo servido directamente no debe poder ejecutar nada.
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  })
);
app.get(/^\/uploads\//, (_req, res) => res.status(404).json({ error: "not_found" }));

// ---------- Exportar / importar (privado, solo el editor) ----------

function sanitizeName(s: string): string {
  const clean = s
    .replace(/[/\\:*?"<>| -]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean || "sin-titulo";
}

// Cada página se exporta como .md con frontmatter (título y carpeta en JSON
// para un round-trip fiable) seguido del markdown tal cual.
app.get("/api/export", async (_req, res) => {
  const zip = new JSZip();
  const folderNames = new Map(folders.list().map((f) => [f.id, f.name]));

  for (const item of pages.list()) {
    const page = pages.get(item.id);
    if (!page) continue;
    const folderName = page.folder_id ? folderNames.get(page.folder_id) ?? null : null;
    const frontmatter =
      `---\ntitle: ${JSON.stringify(page.title)}\n` +
      `folder: ${JSON.stringify(folderName)}\n---\n\n`;
    const dir = folderName ? `pages/${sanitizeName(folderName)}/` : "pages/";
    const file = `${sanitizeName(page.title)}-${page.id.slice(0, 8)}.md`;
    zip.file(dir + file, frontmatter + page.content);
  }

  for (const name of fs.readdirSync(UPLOADS_DIR)) {
    const full = path.join(UPLOADS_DIR, name);
    if (fs.statSync(full).isFile()) zip.file(`uploads/${name}`, fs.readFileSync(full));
  }

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="nouts-export-${stamp}.zip"`
  );
  res.send(buf);
});

const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

function parseFrontmatter(raw: string): {
  title: string;
  folder: string | null;
  content: string;
} {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { title: "", folder: null, content: raw };
  let title = "";
  let folder: string | null = null;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(title|folder):\s*(.*)$/);
    if (!kv) continue;
    try {
      const value = JSON.parse(kv[2]);
      if (kv[1] === "title") title = typeof value === "string" ? value : "";
      else folder = typeof value === "string" ? value : null;
    } catch {
      /* línea no parseable: se ignora */
    }
  }
  return { title, folder, content: raw.slice(m[0].length) };
}

// Importar es no destructivo: añade páginas y reutiliza carpetas por nombre.
app.post("/api/import", async (req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_IMPORT_BYTES) {
        tooBig = true;
        break;
      }
      chunks.push(chunk);
    }
  } catch {
    return res.status(400).json({ error: "read_failed" });
  }
  if (tooBig) return res.status(413).json({ error: "too_large" });

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(Buffer.concat(chunks));
  } catch {
    return res.status(400).json({ error: "invalid_zip" });
  }

  // Restaurar imágenes primero, para que los enlaces /uploads/... resuelvan.
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.startsWith("uploads/")) continue;
    const base = path.basename(entry.name);
    if (base && /\.(png|jpe?g|webp|gif)$/i.test(base)) {
      fs.writeFileSync(path.join(UPLOADS_DIR, base), await entry.async("nodebuffer"));
    }
  }

  const foldersByName = new Map(folders.list().map((f) => [f.name, f.id]));
  let created = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.startsWith("pages/") || !entry.name.endsWith(".md")) {
      continue;
    }
    const { title, folder, content } = parseFrontmatter(await entry.async("string"));
    let folderId: string | null = null;
    if (folder) {
      folderId = foldersByName.get(folder) ?? null;
      if (!folderId) {
        folderId = folders.create(folder).id;
        foldersByName.set(folder, folderId);
      }
    }
    const page = pages.create(title, folderId);
    pages.update(page.id, { content });
    created++;
  }
  res.json({ created });
});

// ---------- Estáticos del frontend ----------

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false }));
  app.get("/s/:token", (_req, res) => {
    res.sendFile(path.join(WEB_DIST, "share.html"));
  });
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
} else {
  console.warn(`[nouts] frontend no encontrado en ${WEB_DIST}; sirviendo solo la API`);
}

// Purga de la papelera: elimina definitivamente lo borrado hace >30 días.
try {
  const purged = purgeTrashOlderThan(30);
  if (purged) console.log(`[nouts] papelera: ${purged} página(s) purgada(s)`);
} catch (e) {
  console.warn("[nouts] no se pudo purgar la papelera:", e);
}

export { app };

// En tests importamos `app` sin abrir el puerto ni resolver DNS.
if (process.env.NODE_ENV !== "test") {
  void resolveProxyIps();
  app.listen(PORT, HOST, () => {
    console.log(`[nouts] escuchando en http://${HOST}:${PORT}`);
  });
}
