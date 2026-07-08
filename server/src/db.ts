import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/data";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "nouts.db"));

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

// Migraciones idempotentes basadas en user_version.
const migrations: string[] = [
  `CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    share_token TEXT UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `ALTER TABLE pages ADD COLUMN share_password_hash TEXT;
   CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS folders (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   ALTER TABLE pages ADD COLUMN folder_id TEXT`,
  // Orden manual: position ASC. Backfill respetando el orden actual
  // (más reciente primero) para que la lista no cambie al actualizar.
  `ALTER TABLE pages ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
   UPDATE pages SET position = (
     SELECT COUNT(*) FROM pages p2 WHERE p2.updated_at > pages.updated_at
   )`,
  // Papelera: soft-delete.
  `ALTER TABLE pages ADD COLUMN deleted_at TEXT`,
  // Búsqueda de texto (FTS5). Tabla independiente sincronizada desde la capa
  // JS (id sin indexar como referencia); backfill de las páginas vivas.
  `CREATE VIRTUAL TABLE pages_fts USING fts5(id UNINDEXED, title, content, tokenize='unicode61');
   INSERT INTO pages_fts(id, title, content)
     SELECT id, title, content FROM pages WHERE deleted_at IS NULL`,
];

const currentVersion = db.pragma("user_version", { simple: true }) as number;
for (let v = currentVersion; v < migrations.length; v++) {
  db.transaction(() => {
    db.exec(migrations[v]);
    db.pragma(`user_version = ${v + 1}`);
  })();
}

export interface Page {
  id: string;
  title: string;
  content: string;
  share_token: string | null;
  share_password_hash: string | null;
  folder_id: string | null;
  position: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Folder {
  id: string;
  name: string;
  created_at: string;
}

const listStmt = db.prepare(
  `SELECT id, title, share_token, share_password_hash IS NOT NULL AS has_password,
          folder_id, position, created_at, updated_at
   FROM pages WHERE deleted_at IS NULL ORDER BY position ASC, updated_at DESC`
);
const getStmt = db.prepare("SELECT * FROM pages WHERE id = ?");
// Público: una página en la papelera no debe servirse por su link.
const getByTokenStmt = db.prepare(
  "SELECT * FROM pages WHERE share_token = ? AND deleted_at IS NULL"
);
const listTrashStmt = db.prepare(
  `SELECT id, title, folder_id, deleted_at, updated_at
   FROM pages WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`
);
const insertStmt = db.prepare(
  "INSERT INTO pages (id, title, content, share_token, folder_id, position, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)"
);
const minPositionStmt = db.prepare("SELECT MIN(position) AS m FROM pages");
const updateStmt = db.prepare(
  "UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?"
);
const setTokenStmt = db.prepare("UPDATE pages SET share_token = ? WHERE id = ?");
const setPasswordStmt = db.prepare(
  "UPDATE pages SET share_password_hash = ? WHERE id = ?"
);
const deleteStmt = db.prepare("DELETE FROM pages WHERE id = ?");
const softDeleteStmt = db.prepare("UPDATE pages SET deleted_at = ? WHERE id = ?");
const restoreStmt = db.prepare("UPDATE pages SET deleted_at = NULL WHERE id = ?");
const purgeOldStmt = db.prepare(
  "DELETE FROM pages WHERE deleted_at IS NOT NULL AND deleted_at < ?"
);
const getMetaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
const setMetaStmt = db.prepare(
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING"
);
const upsertMetaStmt = db.prepare(
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

// Sincronización del índice de búsqueda (FTS5) desde la capa JS.
const ftsInsertStmt = db.prepare(
  "INSERT INTO pages_fts (id, title, content) VALUES (?, ?, ?)"
);
const ftsDeleteStmt = db.prepare("DELETE FROM pages_fts WHERE id = ?");
const ftsSearchStmt = db.prepare(
  `SELECT f.id AS id, p.title AS title,
          snippet(pages_fts, 2, '‹', '›', '…', 12) AS snippet
   FROM pages_fts f JOIN pages p ON p.id = f.id
   WHERE pages_fts MATCH ? AND p.deleted_at IS NULL
   ORDER BY rank LIMIT 40`
);
function ftsReindex(id: string, title: string, content: string): void {
  ftsDeleteStmt.run(id);
  ftsInsertStmt.run(id, title, content);
}

export interface PageListItem {
  id: string;
  title: string;
  share_token: string | null;
  has_password: 0 | 1;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
}

// Valor persistente generado en el primer arranque (p. ej. secreto para
// firmar cookies de acceso a páginas protegidas).
export function getOrCreateMeta(key: string, generate: () => string): string {
  const row = getMetaStmt.get(key) as { value: string } | undefined;
  if (row) return row.value;
  setMetaStmt.run(key, generate());
  return (getMetaStmt.get(key) as { value: string }).value;
}

export function getMeta(key: string): string | null {
  const row = getMetaStmt.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(key: string, value: string): void {
  upsertMetaStmt.run(key, value);
}

// Purga definitiva de la papelera pasados los días indicados.
export function purgeTrashOlderThan(days: number): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const ids = db
    .prepare("SELECT id FROM pages WHERE deleted_at IS NOT NULL AND deleted_at < ?")
    .all(cutoff) as { id: string }[];
  for (const { id } of ids) ftsDeleteStmt.run(id);
  return purgeOldStmt.run(cutoff).changes;
}

export const pages = {
  list: (): PageListItem[] => listStmt.all() as PageListItem[],
  get: (id: string): Page | undefined => getStmt.get(id) as Page | undefined,
  getByToken: (token: string): Page | undefined =>
    getByTokenStmt.get(token) as Page | undefined,
  create(title: string, folderId: string | null = null): Page {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // Nuevas páginas arriba del todo (como antes con updated_at DESC).
    const min = (minPositionStmt.get() as { m: number | null }).m ?? 0;
    insertStmt.run(id, title, "", folderId, min - 1, now, now);
    ftsInsertStmt.run(id, title, "");
    return this.get(id)!;
  },
  update(id: string, fields: { title?: string; content?: string }): Page | undefined {
    const page = this.get(id);
    if (!page) return undefined;
    const now = new Date().toISOString();
    const title = fields.title ?? page.title;
    const content = fields.content ?? page.content;
    updateStmt.run(title, content, now, id);
    ftsReindex(id, title, content);
    return this.get(id);
  },
  search(query: string): { id: string; title: string; snippet: string }[] {
    const tokens = (query.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
    if (!tokens.length) return [];
    const match = tokens.map((t) => `"${t}"*`).join(" ");
    try {
      return ftsSearchStmt.all(match) as { id: string; title: string; snippet: string }[];
    } catch {
      return [];
    }
  },
  setShareToken(id: string, token: string | null): void {
    setTokenStmt.run(token, id);
  },
  setSharePassword(id: string, hash: string | null): void {
    setPasswordStmt.run(hash, id);
  },
  // Mover de carpeta no toca updated_at para no reordenar la lista.
  setFolder(id: string, folderId: string | null): void {
    setFolderStmt.run(folderId, id);
  },
  // Intercambia la posición con el vecino de arriba/abajo dentro del mismo
  // ámbito (misma carpeta, o la raíz). Devuelve true si hubo movimiento.
  reorder: db.transaction((id: string, direction: "up" | "down"): boolean => {
    const page = getStmt.get(id) as Page | undefined;
    if (!page) return false;
    const stmt = direction === "up" ? neighborUpStmt : neighborDownStmt;
    const neighbor = stmt.get(page.folder_id, page.position) as
      | { id: string; position: number }
      | undefined;
    if (!neighbor) return false;
    setPositionStmt.run(neighbor.position, page.id);
    setPositionStmt.run(page.position, neighbor.id);
    return true;
  }),
  // Borrado normal = papelera (soft-delete). Sale del índice de búsqueda.
  delete(id: string): boolean {
    const changed = softDeleteStmt.run(new Date().toISOString(), id).changes > 0;
    if (changed) ftsDeleteStmt.run(id);
    return changed;
  },
  listTrash: (): TrashItem[] => listTrashStmt.all() as TrashItem[],
  restore(id: string): Page | undefined {
    restoreStmt.run(id);
    const page = this.get(id);
    if (page && !page.deleted_at) ftsInsertStmt.run(id, page.title, page.content);
    return page;
  },
  // Borrado definitivo (desde la papelera).
  purge(id: string): boolean {
    ftsDeleteStmt.run(id);
    return deleteStmt.run(id).changes > 0;
  },
};

export interface TrashItem {
  id: string;
  title: string;
  folder_id: string | null;
  deleted_at: string;
  updated_at: string;
}

const setFolderStmt = db.prepare("UPDATE pages SET folder_id = ? WHERE id = ?");
const setPositionStmt = db.prepare("UPDATE pages SET position = ? WHERE id = ?");
// `folder_id IS ?` trata NULL como IS NULL, así que sirve para la raíz.
const neighborUpStmt = db.prepare(
  "SELECT id, position FROM pages WHERE folder_id IS ? AND position < ? ORDER BY position DESC LIMIT 1"
);
const neighborDownStmt = db.prepare(
  "SELECT id, position FROM pages WHERE folder_id IS ? AND position > ? ORDER BY position ASC LIMIT 1"
);
const listFoldersStmt = db.prepare(
  "SELECT * FROM folders ORDER BY name COLLATE NOCASE"
);
const getFolderStmt = db.prepare("SELECT * FROM folders WHERE id = ?");
const insertFolderStmt = db.prepare(
  "INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)"
);
const renameFolderStmt = db.prepare("UPDATE folders SET name = ? WHERE id = ?");
const deleteFolderStmt = db.prepare("DELETE FROM folders WHERE id = ?");
const orphanPagesStmt = db.prepare(
  "UPDATE pages SET folder_id = NULL WHERE folder_id = ?"
);

export const folders = {
  list: (): Folder[] => listFoldersStmt.all() as Folder[],
  get: (id: string): Folder | undefined => getFolderStmt.get(id) as Folder | undefined,
  create(name: string): Folder {
    const id = crypto.randomUUID();
    insertFolderStmt.run(id, name, new Date().toISOString());
    return this.get(id)!;
  },
  rename(id: string, name: string): Folder | undefined {
    renameFolderStmt.run(name, id);
    return this.get(id);
  },
  // Al borrar una carpeta sus páginas pasan a la raíz; nunca se borran.
  delete: db.transaction((id: string): boolean => {
    orphanPagesStmt.run(id);
    return deleteFolderStmt.run(id).changes > 0;
  }),
};
