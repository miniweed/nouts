import { describe, expect, it } from "vitest";
import request from "supertest";
// Importado tras el setup (que fija DATA_DIR/NODE_ENV). La app no abre puerto
// en NODE_ENV=test, así que supertest la usa directamente.
import { app } from "../dist/index.js";

// Cabecera CSRF que exige la API para métodos que mutan estado.
const XRW = { "X-Requested-With": "nouts" };

async function createPage(title = "") {
  const res = await request(app).post("/api/pages").set(XRW).send({ title });
  expect(res.status).toBe(201);
  return res.body as { id: string; title: string; updated_at: string; content: string };
}

describe("salud y CSRF", () => {
  it("responde en /api/health", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("rechaza mutaciones sin la cabecera X-Requested-With", async () => {
    const res = await request(app).post("/api/pages").send({ title: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf");
  });
});

describe("páginas CRUD", () => {
  it("crea, lee, actualiza y borra (a papelera)", async () => {
    const page = await createPage("Hola");
    expect(page.title).toBe("Hola");

    const got = await request(app).get(`/api/pages/${page.id}`);
    expect(got.status).toBe(200);

    const upd = await request(app)
      .put(`/api/pages/${page.id}`)
      .set(XRW)
      .send({ content: "# Contenido" });
    expect(upd.status).toBe(200);
    expect(upd.body.content).toBe("# Contenido");

    const del = await request(app).delete(`/api/pages/${page.id}`).set(XRW);
    expect(del.status).toBe(204);

    // Fuera de la lista principal…
    const list = await request(app).get("/api/pages");
    expect(list.body.find((p: { id: string }) => p.id === page.id)).toBeUndefined();
    // …pero en la papelera.
    const trash = await request(app).get("/api/trash");
    expect(trash.body.find((p: { id: string }) => p.id === page.id)).toBeDefined();
  });
});

describe("papelera", () => {
  it("restaura y purga páginas", async () => {
    const page = await createPage("Temporal");
    await request(app).delete(`/api/pages/${page.id}`).set(XRW);

    const restored = await request(app).post(`/api/pages/${page.id}/restore`).set(XRW);
    expect(restored.status).toBe(200);
    const list = await request(app).get("/api/pages");
    expect(list.body.find((p: { id: string }) => p.id === page.id)).toBeDefined();

    await request(app).delete(`/api/pages/${page.id}`).set(XRW);
    const purge = await request(app).delete(`/api/pages/${page.id}/purge`).set(XRW);
    expect(purge.status).toBe(204);
    const trash = await request(app).get("/api/trash");
    expect(trash.body.find((p: { id: string }) => p.id === page.id)).toBeUndefined();
  });
});

describe("concurrencia optimista", () => {
  it("devuelve 409 si base_updated_at no coincide", async () => {
    const page = await createPage("Conc");
    const first = await request(app)
      .put(`/api/pages/${page.id}`)
      .set(XRW)
      .send({ content: "uno", base_updated_at: page.updated_at });
    expect(first.status).toBe(200);

    // Reutilizar el updated_at viejo debe chocar.
    const conflict = await request(app)
      .put(`/api/pages/${page.id}`)
      .set(XRW)
      .send({ content: "dos", base_updated_at: page.updated_at });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("conflict");
    expect(conflict.body.page.content).toBe("uno");
  });
});

describe("búsqueda", () => {
  it("encuentra páginas por contenido y excluye las borradas", async () => {
    const page = await createPage("Receta");
    await request(app)
      .put(`/api/pages/${page.id}`)
      .set(XRW)
      .send({ content: "berenjenas al horno con tomate" });

    const found = await request(app).get("/api/search?q=berenjenas");
    expect(found.status).toBe(200);
    expect(found.body.find((r: { id: string }) => r.id === page.id)).toBeDefined();

    await request(app).delete(`/api/pages/${page.id}`).set(XRW);
    const afterDelete = await request(app).get("/api/search?q=berenjenas");
    expect(afterDelete.body.find((r: { id: string }) => r.id === page.id)).toBeUndefined();
  });
});

describe("ajustes (dominio público)", () => {
  it("valida y guarda una URL, y rechaza basura", async () => {
    const bad = await request(app)
      .put("/api/settings")
      .set(XRW)
      .send({ public_base_url: "no-es-una-url" });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .put("/api/settings")
      .set(XRW)
      .send({ public_base_url: "https://notas.midominio.com/" });
    expect(ok.status).toBe(200);
    expect(ok.body.public_base_url).toBe("https://notas.midominio.com");

    const got = await request(app).get("/api/settings");
    expect(got.body.public_base_url).toBe("https://notas.midominio.com");
  });
});

describe("carpetas", () => {
  it("crea páginas dentro de una carpeta y la borra sin perder páginas", async () => {
    const folder = await request(app).post("/api/folders").set(XRW).send({ name: "Trabajo" });
    expect(folder.status).toBe(201);
    const fid = folder.body.id as string;

    const res = await request(app).post("/api/pages").set(XRW).send({ folder_id: fid });
    expect(res.status).toBe(201);
    const pid = res.body.id as string;

    const del = await request(app).delete(`/api/folders/${fid}`).set(XRW);
    expect(del.status).toBe(204);
    // La página sobrevive, ahora en la raíz.
    const got = await request(app).get(`/api/pages/${pid}`);
    expect(got.status).toBe(200);
    expect(got.body.folder_id).toBeNull();
  });
});

describe("compartir con slug y contraseña", () => {
  it("crea link, cambia el slug y sirve la página públicamente", async () => {
    const page = await createPage("Pública");
    await request(app).put(`/api/pages/${page.id}`).set(XRW).send({ content: "visible" });

    const share = await request(app).post(`/api/pages/${page.id}/share`).set(XRW);
    expect(share.status).toBe(200);

    const slug = `slug-${Date.now()}`;
    const upd = await request(app)
      .put(`/api/pages/${page.id}/share`)
      .set(XRW)
      .send({ slug });
    expect(upd.status).toBe(200);
    expect(upd.body.share_token).toBe(slug);

    const pub = await request(app).get(`/api/public/${slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.content).toBe("visible");
  });

  it("exige contraseña y aplica el límite por token", async () => {
    const page = await createPage("Secreta");
    const share = await request(app).post(`/api/pages/${page.id}/share`).set(XRW);
    const token = share.body.share_token as string;

    await request(app)
      .put(`/api/pages/${page.id}/share`)
      .set(XRW)
      .send({ password: "abrete-sesamo" });

    // Sin cookie de acceso: 401.
    const locked = await request(app).get(`/api/public/${token}`);
    expect(locked.status).toBe(401);

    // 10 intentos fallidos permitidos; el 11º corta con 429.
    let sawRateLimit = false;
    for (let i = 0; i < 11; i++) {
      const r = await request(app)
        .post(`/api/public/${token}/unlock`)
        .set(XRW)
        .send({ password: "mal" });
      if (r.status === 429) sawRateLimit = true;
    }
    expect(sawRateLimit).toBe(true);
  });
});

describe("exportar / importar (round-trip)", () => {
  it("importa lo exportado y recrea las páginas", async () => {
    const page = await createPage("Exportable");
    await request(app)
      .put(`/api/pages/${page.id}`)
      .set(XRW)
      .send({ content: "contenido exportado" });

    const exp = await request(app).get("/api/export").buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(exp.status).toBe(200);

    const imp = await request(app)
      .post("/api/import")
      .set({ ...XRW, "Content-Type": "application/zip" })
      .send(exp.body as Buffer);
    expect(imp.status).toBe(200);
    expect(imp.body.created).toBeGreaterThanOrEqual(1);
  });
});
