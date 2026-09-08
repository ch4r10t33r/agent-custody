// Tests spawn gateways and sidecars and load PGlite's engine; on a loaded machine that takes longer than the
// five-second default, which produced timeouts that were not failures. Thirty seconds is the budget for one test.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 60_000 } });
