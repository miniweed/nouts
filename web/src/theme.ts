export type Theme = "light" | "dark";

const KEY = "nouts_theme";

export function currentTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(KEY, next);
  apply(next);
  return next;
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

// El HTML ya aplica el tema con un script inline para evitar el destello;
// aquí solo seguimos los cambios del sistema mientras no haya elección manual.
export function initTheme(): void {
  apply(currentTheme());
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (!localStorage.getItem(KEY)) apply(currentTheme());
    });
}
