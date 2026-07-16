import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Next.js resolves this to a no-op via the "react-server" export condition at build
      // time; plain Node (Vitest) falls back to the "default" export, which unconditionally
      // throws. Stub it out for tests — we only import pure functions from server-only
      // modules, never anything that actually needs the runtime check.
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.mts"),
    },
  },
});
