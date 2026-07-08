import { InputRule } from "@milkdown/kit/prose/inputrules";
import { findWrapping } from "@milkdown/kit/prose/transform";
import { $inputRule } from "@milkdown/kit/utils";

// Atajo estilo Notion: escribir "[] ", "[ ] " o "[x] " al principio de un
// párrafo lo convierte en una casilla de tarea. La sintaxis con guion
// ("- [ ] ") ya la maneja gfm dentro de listas; esto cubre el párrafo suelto.
export const taskListInputRule = $inputRule(
  () =>
    new InputRule(/^\[([ xX]?)\]\s$/, (state, match, start, end) => {
      const bulletList = state.schema.nodes.bullet_list;
      const listItem = state.schema.nodes.list_item;
      if (!bulletList || !listItem) return null;

      const $from = state.doc.resolve(start);
      // Si ya estamos dentro de una lista, deja que gfm lo gestione.
      if ($from.node(-1)?.type === listItem) return null;

      const checked = /x/i.test(match[1] ?? "");
      const tr = state.tr.delete(start, end);
      const range = tr.doc.resolve(start).blockRange();
      if (!range) return null;

      const wrapping = findWrapping(range, bulletList);
      if (!wrapping) return null;

      const wrappers = wrapping.map((w) =>
        w.type === listItem ? { type: w.type, attrs: { checked } } : w
      );
      return tr.wrap(range, wrappers);
    })
);
