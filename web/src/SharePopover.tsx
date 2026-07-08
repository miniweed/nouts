import { useEffect, useState } from "react";
import { api, ApiError } from "./api";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/;

interface ShareState {
  share_token: string | null;
  has_password: boolean;
}

interface SharePopoverProps {
  pageId: string;
  shareToken: string | null;
  hasPassword: boolean;
  // Dominio público fijado en Ajustes; si está vacío se usa el origen actual.
  publicBaseUrl: string;
  onChange: (share: ShareState) => void;
}

export default function SharePopover({
  pageId,
  shareToken,
  hasPassword,
  publicBaseUrl,
  onChange,
}: SharePopoverProps) {
  const [slug, setSlug] = useState(shareToken ?? "");
  const [slugError, setSlugError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setSlug(shareToken ?? "");
    setSlugError(null);
  }, [shareToken]);

  const base = (publicBaseUrl || window.location.origin).replace(/\/+$/, "");
  const prefix = `${base}/s/`;
  const usingLocalOrigin = !publicBaseUrl;

  async function create() {
    const { share_token } = await api.createShare(pageId);
    onChange({ share_token, has_password: false });
  }

  async function rotate() {
    const { share_token } = await api.createShare(pageId);
    onChange({ share_token, has_password: hasPassword });
  }

  async function revoke() {
    await api.revokeShare(pageId);
    onChange({ share_token: null, has_password: false });
  }

  async function copy() {
    const text = prefix + shareToken;
    try {
      // navigator.clipboard solo existe en contexto seguro (HTTPS/localhost).
      // Servido por IP local sobre HTTP no está, así que recurrimos a execCommand.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Último recurso: seleccionar el link para copiar a mano.
      window.prompt("Copia el link:", text);
    }
  }

  async function saveSlug() {
    if (!shareToken || slug === shareToken) return;
    if (!SLUG_RE.test(slug)) {
      setSlugError("Usa 3–64 caracteres: letras, números, «-» o «_».");
      return;
    }
    try {
      const share = await api.updateShare(pageId, { slug });
      setSlugError(null);
      onChange(share);
    } catch (e) {
      if (e instanceof ApiError && e.code === "slug_taken") {
        setSlugError("Ese link ya está en uso por otra página.");
      } else {
        setSlugError("No se pudo guardar el link.");
      }
    }
  }

  async function applyPassword() {
    if (!password) return;
    const share = await api.updateShare(pageId, { password });
    setPassword("");
    onChange(share);
  }

  async function removePassword() {
    const share = await api.updateShare(pageId, { password: null });
    onChange(share);
  }

  if (!shareToken) {
    return (
      <div className="share-popover">
        <p className="share-label">Esta página no está compartida.</p>
        <button onClick={create}>Crear link público</button>
      </div>
    );
  }

  return (
    <div className="share-popover">
      <p className="share-label">
        Cualquiera con este link puede ver la página (solo lectura, con cambios en vivo):
      </p>
      <div className="share-url-row">
        <span className="share-url-prefix" title={prefix}>
          {prefix}
        </span>
        <input
          className="share-slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          onBlur={saveSlug}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          spellCheck={false}
        />
      </div>
      {slugError && <p className="share-error">{slugError}</p>}
      {slug !== shareToken && !slugError && (
        <p className="share-hint">Pulsa Enter para guardar el nuevo link; el anterior dejará de funcionar.</p>
      )}
      {usingLocalOrigin && (
        <p className="share-hint">
          Estás usando la dirección local. Fija tu dominio público en Ajustes (⚙) para
          copiar un link que funcione desde fuera de casa.
        </p>
      )}
      <div className="share-actions">
        <button onClick={copy}>{copied ? "¡Copiado!" : "Copiar"}</button>
        <button onClick={rotate} title="Genera un link aleatorio nuevo; el anterior deja de funcionar">
          Rotar
        </button>
        <button className="danger" onClick={revoke}>
          Revocar
        </button>
      </div>

      <hr className="share-sep" />

      <p className="share-label">
        {hasPassword ? "🔒 Protegida con contraseña." : "Sin contraseña: cualquiera con el link puede verla."}
      </p>
      <div className="share-pass-row">
        <input
          type="password"
          className="share-pass-input"
          placeholder={hasPassword ? "Nueva contraseña" : "Contraseña"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyPassword()}
        />
        <button onClick={applyPassword} disabled={!password}>
          {hasPassword ? "Cambiar" : "Establecer"}
        </button>
        {hasPassword && (
          <button className="danger" onClick={removePassword}>
            Quitar
          </button>
        )}
      </div>
    </div>
  );
}
