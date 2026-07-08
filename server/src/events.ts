import { EventEmitter } from "node:events";

export type PageEvent =
  | { type: "update"; title: string; content: string; updated_at: string }
  | { type: "reauth" }
  | { type: "gone" };

// Bus in-process: los PUT/DELETE de páginas emiten aquí y los streams SSE
// suscritos al id de la página reciben el evento.
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(pageId: string, event: PageEvent): void {
  bus.emit(`page:${pageId}`, event);
}

export function subscribe(
  pageId: string,
  listener: (event: PageEvent) => void
): () => void {
  bus.on(`page:${pageId}`, listener);
  return () => bus.off(`page:${pageId}`, listener);
}
