import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FactSchema = z.object({
  /** key under context.facts */
  name: z.string().min(1),
  /** upstream tool the gateway calls to obtain the fact */
  tool: z.string().min(1),
  /** argument template; values of the form "$args.<key>" are taken from the intercepted call */
  args: z.record(z.string(), z.string()),
  /** which intercepted tools trigger this lookup */
  forTools: z.array(z.string().min(1)).min(1),
});

export const GatewayConfigSchema = z.object({
  identity: z.object({ keyFile: z.string() }),
  upstream: z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }),
  grantFile: z.string(),
  trustedPrincipalKeys: z.array(z.string()).min(1),
  policyFile: z.string(),
  facts: z.array(FactSchema).default([]),
  receiptsDir: z.string(),
  logFile: z.string(),
});
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type FactConfig = z.infer<typeof FactSchema>;

/** Loads a config file and resolves every path relative to the file's directory. */
export function loadConfig(path: string): GatewayConfig {
  const cfg = GatewayConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const base = dirname(resolve(path));
  const r = (p: string) => resolve(base, p);
  return {
    ...cfg,
    identity: { keyFile: r(cfg.identity.keyFile) },
    grantFile: r(cfg.grantFile),
    trustedPrincipalKeys: cfg.trustedPrincipalKeys.map(r),
    policyFile: r(cfg.policyFile),
    receiptsDir: r(cfg.receiptsDir),
    logFile: r(cfg.logFile),
  };
}
