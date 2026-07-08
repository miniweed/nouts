import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Folder, type Page, type PageSummary } from "./api";
import Editor from "./Editor";
import SettingsPanel from "./SettingsPanel";
import SharePopover from "./SharePopover";
import Sidebar from "./Sidebar";

type SaveState = "saved" | "saving" | "error" | "conflict";

export default function App() {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [current, setCurrent] = useState<Page | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [shareOpen, setShareOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  // Fuerza remontar el editor tras recargar por un conflicto de edición.
  const [reloadNonce, setReloadNonce] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const pendingContent = useRef<string | null>(null);
  // updated_at conocido de la página actual (base para concurrencia optimista).
  const baseUpdatedAt = useRef<string>("");

  const refreshList = useCallback(async () => {
    const list = await api.listPages();
    setPages(list);
    return list;
  }, []);

  useEffect(() => {
    api.listFolders().then(setFolders);
    api.getSettings().then((s) => setPublicBaseUrl(s.public_base_url)).catch(() => {});
    refreshList().then((list) => {
      if (list.length > 0) selectPage(list[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectPage(id: string) {
    flushSave();
    const page = await api.getPage(id);
    setCurrent(page);
    baseUpdatedAt.current = page.updated_at;
    setShareOpen(false);
    setSidebarOpen(false); // en móvil, cierra el cajón al abrir una página
    setSaveState("saved");
  }

  async function createPage(folderId: string | null = null) {
    const page = await api.createPage("", folderId);
    await refreshList();
    setCurrent(page);
    baseUpdatedAt.current = page.updated_at;
    setShareOpen(false);
  }

  async function movePage(pageId: string, folderId: string | null) {
    await api.updatePage(pageId, { folder_id: folderId });
    await refreshList();
    if (current?.id === pageId) setCurrent({ ...current, folder_id: folderId });
  }

  async function reorderPage(pageId: string, direction: "up" | "down") {
    await api.reorderPage(pageId, direction);
    await refreshList();
  }

  async function importFile(file: File) {
    try {
      const { created } = await api.importZip(file);
      setFolders(await api.listFolders());
      await refreshList();
      alert(`Importación completada: ${created} página(s) añadida(s).`);
    } catch {
      alert("No se pudo importar el archivo. Asegúrate de que es un .zip exportado por Nouts.");
    }
  }

  async function createFolder() {
    const name = prompt("Nombre de la carpeta:")?.trim();
    if (!name) return;
    const folder = await api.createFolder(name);
    setFolders(await api.listFolders());
    return folder;
  }

  async function renameFolder(folder: Folder) {
    const name = prompt("Nuevo nombre de la carpeta:", folder.name)?.trim();
    if (!name || name === folder.name) return;
    await api.renameFolder(folder.id, name);
    setFolders(await api.listFolders());
  }

  async function deleteFolder(folder: Folder) {
    const count = pages.filter((p) => p.folder_id === folder.id).length;
    const detail = count > 0 ? ` Sus ${count} página(s) pasarán fuera de la carpeta.` : "";
    if (!confirm(`¿Borrar la carpeta «${folder.name}»?${detail}`)) return;
    await api.deleteFolder(folder.id);
    setFolders(await api.listFolders());
    await refreshList();
  }

  async function deletePage(page: PageSummary) {
    if (!confirm(`¿Enviar «${page.title || "Sin título"}» a la papelera? Podrás restaurarla desde Ajustes.`)) return;
    await api.deletePage(page.id);
    const list = await refreshList();
    if (current?.id === page.id) {
      if (list.length > 0) await selectPage(list[0].id);
      else setCurrent(null);
    }
  }

  // Otra pestaña/dispositivo guardó antes: recarga el contenido del servidor y
  // avisa, en vez de pisar en silencio los cambios del otro lado.
  async function reloadOnConflict(id: string) {
    pendingContent.current = null;
    clearTimeout(saveTimer.current);
    const fresh = await api.getPage(id).catch(() => null);
    if (!fresh) return;
    setCurrent(fresh);
    baseUpdatedAt.current = fresh.updated_at;
    setReloadNonce((n) => n + 1);
    setSaveState("conflict");
    refreshList();
  }

  function scheduleSave(id: string, fields: { title?: string; content?: string }) {
    setSaveState("saving");
    if (fields.content !== undefined) pendingContent.current = fields.content;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const content = pendingContent.current;
        pendingContent.current = null;
        const updated = await api.updatePage(id, {
          ...fields,
          ...(content !== null ? { content } : {}),
          base_updated_at: baseUpdatedAt.current || undefined,
        });
        if (updated) baseUpdatedAt.current = updated.updated_at;
        setSaveState("saved");
        refreshList();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          await reloadOnConflict(id);
        } else {
          setSaveState("error");
        }
      }
    }, 800);
  }

  function flushSave() {
    // Si hay un guardado pendiente al cambiar de página, dispáralo ya.
    if (saveTimer.current && current && pendingContent.current !== null) {
      clearTimeout(saveTimer.current);
      const content = pendingContent.current;
      pendingContent.current = null;
      api.updatePage(current.id, { content }).catch(() => setSaveState("error"));
    }
  }

  function onTitleChange(title: string) {
    if (!current) return;
    setCurrent({ ...current, title });
    scheduleSave(current.id, { title });
  }

  function onContentChange(markdown: string) {
    if (!current) return;
    scheduleSave(current.id, { content: markdown });
  }

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : ""}`}>
      <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      <Sidebar
        pages={pages}
        folders={folders}
        currentId={current?.id ?? null}
        onSelect={selectPage}
        onCreatePage={createPage}
        onDeletePage={deletePage}
        onMovePage={movePage}
        onReorderPage={reorderPage}
        onCreateFolder={createFolder}
        onRenameFolder={renameFolder}
        onDeleteFolder={deleteFolder}
        onImportFile={importFile}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="main">
        <button
          className="hamburger"
          onClick={() => setSidebarOpen(true)}
          aria-label="Abrir menú"
        >
          ☰
        </button>
        {current ? (
          <>
            <header className="topbar">
              <span className={`save-state save-${saveState}`}>
                {saveState === "saving" && "Guardando…"}
                {saveState === "saved" && "Guardado"}
                {saveState === "error" && "Error al guardar"}
                {saveState === "conflict" && "Editado en otro sitio · recargado"}
              </span>
              <div className="share-wrap">
                <button className="btn-share" onClick={() => setShareOpen(!shareOpen)}>
                  Compartir
                </button>
                {shareOpen && (
                  <SharePopover
                    pageId={current.id}
                    shareToken={current.share_token}
                    hasPassword={!!current.has_password}
                    publicBaseUrl={publicBaseUrl}
                    onChange={(share) => {
                      setCurrent({ ...current, ...share });
                      refreshList();
                    }}
                  />
                )}
              </div>
            </header>
            <div className="page-body">
              <input
                className="title-input"
                placeholder="Sin título"
                value={current.title}
                onChange={(e) => onTitleChange(e.target.value)}
              />
              <Editor
                key={`${current.id}:${reloadNonce}`}
                pageId={current.id}
                initialContent={current.content}
                onChange={onContentChange}
              />
            </div>
          </>
        ) : (
          <div className="empty-state">
            <h1>📝 Nouts</h1>
            <p>Tus páginas, en markdown, compartibles con un link.</p>
            <button className="btn-share" onClick={() => createPage(null)}>
              Crear una página
            </button>
          </div>
        )}
      </main>

      {settingsOpen && (
        <SettingsPanel
          publicBaseUrl={publicBaseUrl}
          onSaveBaseUrl={setPublicBaseUrl}
          onRestored={() => {
            refreshList();
            api.listFolders().then(setFolders);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
