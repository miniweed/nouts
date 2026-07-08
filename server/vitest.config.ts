import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // La API comparte una única instancia (BD en un tmp) entre tests; se
    // ejecutan en serie para que el estado sea predecible.
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
  },
});
