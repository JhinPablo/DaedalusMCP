import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".daedalus/**", ".taste-skill/**"],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
