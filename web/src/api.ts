export interface PageSummary {
  id: string;
  title: string;
  share_token: string | null;
  has_password: boolean | 0 | 1;
  folder_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Folder {
  id: string;
  name: string;
  created_at: string;
}

export interface Page extends PageSummary {
  content: string;
}

export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
}

export interface TrashItem {
  id: string;
  title: string;
  folder_id: string | null;
  deleted_at: string;
  updated_at: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  // Cuerpo opcional del error (p. ej. la página actual en un conflicto 409).
  body: Record<string, unknown>;
  constructor(status: number, code: string, body: Record<string, unknown> = {}) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = options;
  const res = await fetch(url, {
    // Cabecera personalizada: protección CSRF (un sitio cross-origin no puede
    // fijarla sin un preflight que el servidor no responde).
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "nouts",
      ...headers,
    },
    ...rest,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listPages: () => request<PageSummary[]>("/api/pages"),
  getPage: (id: string) => request<Page>(`/api/pages/${id}`),
  createPage: (title = "", folderId: string | null = null) =>
    request<Page>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ title, folder_id: folderId }),
    }),
  updatePage: (
    id: string,
    fields: {
      title?: string;
      content?: string;
      folder_id?: string | null;
      base_updated_at?: string;
    }
  ) =>
    request<Page>(`/api/pages/${id}`, { method: "PUT", body: JSON.stringify(fields) }),
  listFolders: () => request<Folder[]>("/api/folders"),
  createFolder: (name: string) =>
    request<Folder>("/api/folders", { method: "POST", body: JSON.stringify({ name }) }),
  renameFolder: (id: string, name: string) =>
    request<Folder>(`/api/folders/${id}`, { method: "PUT", body: JSON.stringify({ name }) }),
  deleteFolder: (id: string) =>
    request<void>(`/api/folders/${id}`, { method: "DELETE" }),
  exportUrl: "/api/export",
  importZip: (file: File) =>
    request<{ created: number }>("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
    }),
  deletePage: (id: string) =>
    request<void>(`/api/pages/${id}`, { method: "DELETE" }),
  reorderPage: (id: string, direction: "up" | "down") =>
    request<{ moved: boolean }>(`/api/pages/${id}/reorder`, {
      method: "POST",
      body: JSON.stringify({ direction }),
    }),
  createShare: (id: string) =>
    request<{ share_token: string }>(`/api/pages/${id}/share`, { method: "POST" }),
  updateShare: (id: string, fields: { slug?: string; password?: string | null }) =>
    request<{ share_token: string; has_password: boolean }>(`/api/pages/${id}/share`, {
      method: "PUT",
      body: JSON.stringify(fields),
    }),
  revokeShare: (id: string) =>
    request<void>(`/api/pages/${id}/share`, { method: "DELETE" }),
  getSettings: () => request<{ public_base_url: string }>("/api/settings"),
  updateSettings: (publicBaseUrl: string) =>
    request<{ public_base_url: string }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ public_base_url: publicBaseUrl }),
    }),
  search: (q: string) =>
    request<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`),
  listTrash: () => request<TrashItem[]>("/api/trash"),
  restorePage: (id: string) =>
    request<Page>(`/api/pages/${id}/restore`, { method: "POST" }),
  purgePage: (id: string) =>
    request<void>(`/api/pages/${id}/purge`, { method: "DELETE" }),
};
