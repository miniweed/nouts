import DOMPurify from "dompurify";
import { marked } from "marked";
import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import ThemeToggle from "./ThemeToggle";
import { initTheme } from "./theme";
import "./share.css";

initTheme();

interface PublicPage {
  title: string;
  content: string;
  updated_at: string;
}

type PageEvent = ({ type: "update" } & PublicPage) | { type: "reauth" } | { type: "gone" };

type Phase = "loading" | "locked" | "ready" | "gone";

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 5) return "ahora mismo";
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return new Date(iso).toLocaleString();
}

function ShareView() {
  const token = window.location.pathname.replace(/^\/s\//, "").replace(/\/+$/, "");
  const [phase, setPhase] = useState<Phase>("loading");
  const [page, setPage] = useState<PublicPage | null>(null);
  const [live, setLive] = useState(false);
  const [lockNote, setLockNote] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pwdError, setPwdError] = useState<string | null>(null);
  const [, forceTick] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);
  const lastErrorCheck = useRef(0);

  const startSSE = useCallback(() => {
    sourceRef.current?.close();
    const source = new EventSource(`/api/public/${token}/events`);
    sourceRef.current = source;
    source.onopen = () => setLive(true);
    source.onmessage = (e) => {
      const event: PageEvent = JSON.parse(e.data);
      if (event.type === "gone") {
        setPhase("gone");
        source.close();
      } else if (event.type === "reauth") {
        source.close();
        setLive(false);
        setLockNote("El autor ha cambiado la contraseña de esta página.");
        setPhase("locked");
      } else {
        setPage({ title: event.title, content: event.content, updated_at: event.updated_at });
        setPhase("ready");
      }
    };
    source.onerror = async () => {
      setLive(false);
      // EventSource reintenta solo; comprueba de vez en cuando si el fallo
      // es de acceso (contraseña/borrado) y no un corte de red.
      const now = Date.now();
      if (now - lastErrorCheck.current < 5000) return;
      lastErrorCheck.current = now;
      const res = await fetch(`/api/public/${token}`).catch(() => null);
      if (res?.status === 401) {
        source.close();
        setLockNote(null);
        setPhase("locked");
      } else if (res?.status === 404) {
        source.close();
        setPhase("gone");
      }
    };
  }, [token]);

  const load = useCallback(async () => {
    if (!token) {
      setPhase("gone");
      return;
    }
    const res = await fetch(`/api/public/${token}`).catch(() => null);
    if (!res) return;
    if (res.status === 401) {
      setPhase("locked");
    } else if (!res.ok) {
      setPhase("gone");
    } else {
      setPage(await res.json());
      setPhase("ready");
      startSSE();
    }
  }, [token, startSSE]);

  useEffect(() => {
    load();
    return () => sourceRef.current?.close();
  }, [load]);

  async function unlock(e: FormEvent) {
    e.preventDefault();
    setPwdError(null);
    const res = await fetch(`/api/public/${token}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    if (res?.ok) {
      setPassword("");
      setLockNote(null);
      await load();
    } else if (res?.status === 429) {
      setPwdError("Demasiados intentos. Espera unos minutos.");
    } else if (res?.status === 404) {
      setPhase("gone");
    } else {
      setPwdError("Contraseña incorrecta.");
    }
  }

  // Refresca el "actualizado hace X" cada 10 s.
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, []);

  // Título de la pestaña = título de la página compartida.
  useEffect(() => {
    document.title = page?.title ? `${page.title} · Nouts` : "Nouts";
  }, [page?.title]);

  if (phase === "gone") {
    return (
      <div className="share-message">
        <h1>🔗</h1>
        <p>Este link ya no está disponible.</p>
      </div>
    );
  }

  if (phase === "locked") {
    return (
      <div className="share-message">
        <h1>🔒</h1>
        <p>Esta página está protegida con contraseña.</p>
        {lockNote && <p className="lock-note">{lockNote}</p>}
        <form className="unlock-form" onSubmit={unlock}>
          <input
            type="password"
            autoFocus
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={!password}>
            Entrar
          </button>
        </form>
        {pwdError && <p className="unlock-error">{pwdError}</p>}
      </div>
    );
  }

  if (phase === "loading" || !page) {
    return <div className="share-message"><p>Cargando…</p></div>;
  }

  const html = DOMPurify.sanitize(marked.parse(page.content, { async: false }));

  return (
    <div className="share-page">
      <header className="share-header">
        <h1>{page.title || "Sin título"}</h1>
        <p className="share-meta">
          <span className={`live-dot ${live ? "on" : "off"}`} />
          {live ? "En vivo" : "Reconectando…"} · actualizado {timeAgo(page.updated_at)}
        </p>
      </header>
      <article className="share-content" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeToggle className="share-theme-toggle" />
    <ShareView />
  </StrictMode>
);
