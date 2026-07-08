import { useEffect, useState } from "react";
import { api, ApiError, type TrashItem } from "./api";

interface SettingsPanelProps {
  publicBaseUrl: string;
  onSaveBaseUrl: (value: string) => void;
  // Se llama tras restaurar una página para refrescar la lista principal.
  onRestored: () => void;
  onClose: () => void;
}

function trashAge(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  return `hace ${days} días`;
}

export default function SettingsPanel({
  publicBaseUrl,
  onSaveBaseUrl,
  onRestored,
  onClose,
}: SettingsPanelProps) {
  const [url, setUrl] = useState(publicBaseUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlSaved, setUrlSaved] = useState(false);
  const [trash, setTrash] = useState<TrashItem[]>([]);

  useEffect(() => {
    api.listTrash().then(setTrash).catch(() => setTrash([]));
  }, []);

  // Cerrar con Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function saveUrl() {
    setUrlError(null);
    try {
      const { public_base_url } = await api.updateSettings(url.trim());
      setUrl(public_base_url);
      onSaveBaseUrl(public_base_url);
      setUrlSaved(true);
      setTimeout(() => setUrlSaved(false), 1500);
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_url") {
        setUrlError("Escribe una URL válida, p. ej. https://notas.midominio.com");
      } else {
        setUrlError("No se pudo guardar.");
      }
    }
  }

  async function restore(item: TrashItem) {
    await api.restorePage(item.id);
    setTrash((t) => t.filter((x) => x.id !== item.id));
    onRestored();
  }

  async function purge(item: TrashItem) {
    if (!confirm(`¿Eliminar definitivamente «${item.title || "Sin título"}»? No se podrá recuperar.`)) {
      return;
    }
    await api.purgePage(item.id);
    setTrash((t) => t.filter((x) => x.id !== item.id));
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Ajustes</h2>
          <button className="modal-close" onClick={onClose} title="Cerrar">
            ×
          </button>
        </header>

        <section className="modal-section">
          <h3>Dominio público</h3>
          <p className="modal-hint">
            Dirección desde la que expones las páginas compartidas (a través de tu
            túnel o proxy). Al copiar un link de compartir se usará este dominio en
            vez de la dirección local.
          </p>
          <div className="settings-url-row">
            <input
              className="settings-url-input"
              placeholder="https://notas.midominio.com"
              value={url}
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveUrl()}
            />
            <button onClick={saveUrl}>{urlSaved ? "¡Guardado!" : "Guardar"}</button>
          </div>
          {urlError && <p className="share-error">{urlError}</p>}
          {!url && !urlError && (
            <p className="modal-hint">Vacío: se usará la dirección desde la que abras la app.</p>
          )}
        </section>

        <section className="modal-section">
          <h3>Papelera</h3>
          <p className="modal-hint">
            Las páginas borradas se guardan aquí y se eliminan solas pasados 30 días.
          </p>
          {trash.length === 0 ? (
            <p className="modal-empty">La papelera está vacía.</p>
          ) : (
            <ul className="trash-list">
              {trash.map((item) => (
                <li key={item.id} className="trash-item">
                  <span className="trash-title">{item.title || "Sin título"}</span>
                  <span className="trash-age">{trashAge(item.deleted_at)}</span>
                  <span className="trash-actions">
                    <button onClick={() => restore(item)}>Restaurar</button>
                    <button className="danger" onClick={() => purge(item)}>
                      Eliminar
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
