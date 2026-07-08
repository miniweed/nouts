import crypto from "node:crypto";
import type { Request, Response } from "express";
import { getOrCreateMeta, type Page } from "./db.js";

// Secreto por instalación, generado en el primer arranque y persistido en la BD.
const cookieSecret = getOrCreateMeta("cookie_secret", () =>
  crypto.randomBytes(32).toString("hex")
);

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return `${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split("$");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 32);
  const expectedBuf = Buffer.from(expected, "hex");
  return (
    actual.length === expectedBuf.length && crypto.timingSafeEqual(actual, expectedBuf)
  );
}

// El valor de la cookie ata token + hash actual: cambiar la contraseña o el
// slug invalida los accesos anteriores sin guardar sesiones en el servidor.
function cookieValue(token: string, passwordHash: string): string {
  return crypto
    .createHmac("sha256", cookieSecret)
    .update(`${token}:${passwordHash}`)
    .digest("hex");
}

function cookieName(token: string): string {
  return `ns_${token}`;
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function grantShareAccess(res: Response, page: Page): void {
  if (!page.share_token || !page.share_password_hash) return;
  const value = cookieValue(page.share_token, page.share_password_hash);
  res.setHeader(
    "Set-Cookie",
    `${cookieName(page.share_token)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
  );
}

export function hasShareAccess(req: Request, page: Page): boolean {
  if (!page.share_password_hash) return true;
  if (!page.share_token) return false;
  const provided = parseCookies(req)[cookieName(page.share_token)];
  if (!provided) return false;
  const expected = cookieValue(page.share_token, page.share_password_hash);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Limitador de intentos de contraseña en memoria.
// La IP del cliente no es de fiar detrás de un reverse proxy o túnel (la
// cabecera X-Forwarded-For se puede falsificar), así que la garantía real es
// el límite POR TOKEN: una página protegida solo admite TOKEN_MAX intentos por
// ventana, se falsee o no la IP. El límite por IP es defensa secundaria.
type Bucket = { count: number; resetAt: number };
const WINDOW_MS = 5 * 60_000;
const TOKEN_MAX = 10;
const IP_MAX = 30;
const tokenAttempts = new Map<string, Bucket>();
const ipAttempts = new Map<string, Bucket>();

function underLimit(
  map: Map<string, Bucket>,
  key: string,
  now: number,
  max: number
): boolean {
  const entry = map.get(key);
  if (!entry || now > entry.resetAt) {
    map.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count++;
  if (map.size > 10_000) map.clear();
  return entry.count <= max;
}

export function rateLimitUnlock(req: Request, token: string): boolean {
  const now = Date.now();
  // Se evalúan ambos (y por tanto cuentan) siempre.
  const okToken = underLimit(tokenAttempts, token, now, TOKEN_MAX);
  const okIp = underLimit(ipAttempts, req.ip ?? "unknown", now, IP_MAX);
  return okToken && okIp;
}

// Un desbloqueo correcto no debe penalizar a un lector legítimo.
export function clearUnlockAttempts(token: string): void {
  tokenAttempts.delete(token);
}
