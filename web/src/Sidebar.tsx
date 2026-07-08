import { useEffect, useRef, useState } from "react";
import { api, type Folder, type PageSummary, type SearchResult } from "./api";
import ThemeToggle from "./ThemeToggle";

interface SidebarProps {
  pages: PageSummary[];
  folders: Folder[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreatePage: (folderId: string | null) => void;
  onDeletePage: (page: PageSummary) => void;
  onMovePage: (pageId: string, folderId: string | null) => void;
  onReorderPage: (pageId: string, direction: "up" | "down") => void;
  onCreateFolder: () => void;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onImportFile: (file: File) => void;
  onOpenSettings: () => void;
}

const COLLAPSED_KEY = "nouts_collapsed_folders";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

export default function Sidebar({
  pages,
  folders,
  currentId,
  onSelect,
  onCreatePage,
  onDeletePage,
  onMovePage,
  onReorderPage,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onImportFile,
  onOpenSettings,
}: SidebarProps) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  // Búsqueda con rebote: no consulta en cada tecla.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api.search(q).then(setResults).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Cierra el menú de mover al hacer clic fuera.
  useEffect(() => {
    if (!moveMenuFor) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMoveMenuFor(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [moveMenuFor]);

  function toggleFolder(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderPage(p: PageSummary, inFolder: boolean, isFirst: boolean, isLast: boolean) {
    return (
      <div
        key={p.id}
        className={`page-item ${currentId === p.id ? "active" : ""} ${inFolder ? "in-folder" : ""}`}
        onClick={() => onSelect(p.id)}
      >
        <span className="page-item-title">{p.title || "Sin título"}</span>
        {p.share_token && <span className="page-item-shared" title="Compartida">🔗</span>}
        <span className="page-item-actions">
          <button
            className="page-item-btn"
            title="Subir"
            disabled={isFirst}
            onClick={(e) => {
              e.stopPropagation();
              onReorderPage(p.id, "up");
            }}
          >
            ↑
          </button>
          <button
            className="page-item-btn"
            title="Bajar"
            disabled={isLast}
            onClick={(e) => {
              e.stopPropagation();
              onReorderPage(p.id, "down");
            }}
          >
            ↓
          </button>
          <button
            className="page-item-btn"
            title="Mover a carpeta"
            onClick={(e) => {
              e.stopPropagation();
              setMoveMenuFor(moveMenuFor === p.id ? null : p.id);
            }}
          >
            📁
          </button>
          <button
            className="page-item-btn delete"
            title="Borrar página"
            onClick={(e) => {
              e.stopPropagation();
              onDeletePage(p);
            }}
          >
            ×
          </button>
        </span>
        {moveMenuFor === p.id && (
          <div className="move-menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <p className="move-menu-title">Mover a…</p>
            <button
              className="move-menu-item"
              disabled={p.folder_id === null}
              onClick={() => {
                onMovePage(p.id, null);
                setMoveMenuFor(null);
              }}
            >
              Sin carpeta
            </button>
            {folders.map((f) => (
              <button
                key={f.id}
                className="move-menu-item"
                disabled={p.folder_id === f.id}
                onClick={() => {
                  onMovePage(p.id, f.id);
                  setMoveMenuFor(null);
                }}
              >
                📁 {f.name}
              </button>
            ))}
            {folders.length === 0 && (
              <p className="move-menu-empty">No hay carpetas todavía.</p>
            )}
          </div>
        )}
      </div>
    );
  }

  const rootPages = pages.filter((p) => !p.folder_id);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo">📝 Nouts</span>
        <span className="sidebar-header-actions">
          <ThemeToggle className="btn-new" />
          <button className="btn-new" onClick={onOpenSettings} title="Ajustes">
            ⚙
          </button>
          <button className="btn-new" onClick={onCreateFolder} title="Nueva carpeta">
            📁
          </button>
          <button className="btn-new" onClick={() => onCreatePage(null)} title="Nueva página">
            +
          </button>
        </span>
      </div>
      <div className="sidebar-search">
        <input
          className="search-input"
          type="search"
          placeholder="🔍 Buscar…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      {query.trim() ? (
        <nav className="page-list search-results">
          {results.length === 0 ? (
            <p className="empty-hint">Sin resultados para «{query.trim()}».</p>
          ) : (
            results.map((r) => (
              <div
                key={r.id}
                className={`search-result ${currentId === r.id ? "active" : ""}`}
                onClick={() => {
                  onSelect(r.id);
                  setQuery("");
                }}
              >
                <span className="search-result-title">{r.title || "Sin título"}</span>
                {r.snippet && (
                  <span className="search-result-snippet">{r.snippet}</span>
                )}
              </div>
            ))
          )}
        </nav>
      ) : (
      <nav className="page-list">
        {folders.map((f) => {
          const folderPages = pages.filter((p) => p.folder_id === f.id);
          const isCollapsed = collapsed.has(f.id);
          return (
            <div key={f.id} className="folder">
              <div className="folder-row" onClick={() => toggleFolder(f.id)}>
                <span className="folder-chevron">{isCollapsed ? "▸" : "▾"}</span>
                <span className="folder-name" title={f.name}>
                  {f.name}
                </span>
                <span className="folder-count">{folderPages.length}</span>
                <span className="page-item-actions">
                  <button
                    className="page-item-btn"
                    title="Nueva página en esta carpeta"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreatePage(f.id);
                    }}
                  >
                    +
                  </button>
                  <button
                    className="page-item-btn"
                    title="Renombrar carpeta"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRenameFolder(f);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="page-item-btn delete"
                    title="Borrar carpeta (las páginas pasan fuera)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteFolder(f);
                    }}
                  >
                    ×
                  </button>
                </span>
              </div>
              {!isCollapsed && (
                <div className="folder-pages">
                  {folderPages.map((p, i) =>
                    renderPage(p, true, i === 0, i === folderPages.length - 1)
                  )}
                  {folderPages.length === 0 && (
                    <p className="empty-hint small">Carpeta vacía</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {rootPages.map((p, i) =>
          renderPage(p, false, i === 0, i === rootPages.length - 1)
        )}
        {pages.length === 0 && folders.length === 0 && (
          <p className="empty-hint">Crea tu primera página con el botón +</p>
        )}
      </nav>
      )}
      <div className="sidebar-footer">
        <a className="footer-btn" href="/api/export" title="Descargar un .zip con todas las páginas e imágenes">
          ⬇ Exportar
        </a>
        <button
          className="footer-btn"
          title="Restaurar desde un .zip exportado (añade páginas, no borra)"
          onClick={() => importInputRef.current?.click()}
        >
          ⬆ Importar
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImportFile(file);
            e.target.value = "";
          }}
        />
      </div>
    </aside>
  );
}
