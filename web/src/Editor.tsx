import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { wrapInHeadingCommand } from "@milkdown/kit/preset/commonmark";
import { useEffect, useRef } from "react";
import { taskListInputRule } from "./taskListInputRule";

interface EditorProps {
  pageId: string;
  initialContent: string;
  onChange: (markdown: string) => void;
}

// Iconos del toolbar de selección para convertir el bloque (texto / H1–H3).
function labelIcon(label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><text x="12" y="16" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="11" font-weight="700" fill="currentColor">${label}</text></svg>`;
}

// nivel 0 = párrafo (texto normal); 1–3 = encabezado de ese nivel.
function blockIsActive(level: number) {
  return (ctx: Ctx): boolean => {
    const node = ctx.get(editorViewCtx).state.selection.$from.parent;
    return level === 0
      ? node.type.name === "paragraph"
      : node.type.name === "heading" && node.attrs.level === level;
  };
}

function convertBlock(level: number) {
  return (ctx: Ctx): void => {
    // wrapInHeadingCommand con nivel 0 aplica setBlockType(párrafo); con 1–6
    // convierte al encabezado de ese nivel. Ambos funcionan con texto
    // seleccionado (a diferencia de downgradeHeadingCommand).
    ctx.get(commandsCtx).call(wrapInHeadingCommand.key, level);
  };
}

async function uploadImage(file: File): Promise<string> {
  const res = await fetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": file.type, "X-Requested-With": "nouts" },
    body: file,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const { url } = await res.json();
  return url;
}

// Monta una instancia de Crepe por página; al cambiar de página se destruye
// y se crea de nuevo con el contenido de la página seleccionada.
export default function Editor({ pageId, initialContent, onChange }: EditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let destroyed = false;
    const crepe = new Crepe({
      root,
      defaultValue: initialContent,
      featureConfigs: {
        [Crepe.Feature.Placeholder]: {
          text: "Escribe algo, o pulsa «/» para insertar bloques…",
          mode: "doc",
        },
        [Crepe.Feature.ImageBlock]: {
          // Sube el archivo al servidor y devuelve una URL persistente y
          // pública, para que quien abra el link compartido vea la imagen.
          onUpload: uploadImage,
        },
        [Crepe.Feature.Toolbar]: {
          // Añade al toolbar de selección la opción de cambiar el formato del
          // bloque actual: Texto normal o encabezados H1–H3.
          buildToolbar: (builder) => {
            const group = builder.addGroup("style", "Estilo");
            const items: [string, number, string][] = [
              ["text", 0, "T"],
              ["h1", 1, "H1"],
              ["h2", 2, "H2"],
              ["h3", 3, "H3"],
            ];
            for (const [key, level, label] of items) {
              group.addItem(key, {
                icon: labelIcon(label),
                active: blockIsActive(level),
                onRun: convertBlock(level),
              });
            }
          },
        },
      },
    });
    crepe.editor.use(taskListInputRule);
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (markdown !== prevMarkdown) onChangeRef.current(markdown);
      });
    });
    crepe.create().then(() => {
      if (destroyed) crepe.destroy();
    });

    return () => {
      destroyed = true;
      crepe.destroy();
      root.innerHTML = "";
    };
    // initialContent solo importa al montar; las ediciones locales no deben remontar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  return <div className="editor-root" ref={rootRef} />;
}
