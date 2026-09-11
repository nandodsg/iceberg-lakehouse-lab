import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HarnessConfig, IntegrationModule } from "./types.js";

/**
 * Loads the generic (non-secret) config and dynamically imports the
 * integration module it points to. That module — real base URL routing
 * already baked into its own code, real auth, real journey-state checks
 * — is never part of this repository. See config.example.json and
 * README.md.
 */
type RawConfig = Partial<HarnessConfig>;

export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as RawConfig;
  if (!parsed.baseUrl || !parsed.integrationModulePath) {
    throw new Error(
      `Invalid config at ${configPath}: baseUrl and integrationModulePath are required.`
    );
  }
  return {
    timeoutSeconds: 600,
    outputDir: "runs",
    ...parsed,
    baseUrl: parsed.baseUrl,
    integrationModulePath: parsed.integrationModulePath,
  };
}

export async function loadIntegrationModule(
  configPath: string,
  config: HarnessConfig
): Promise<IntegrationModule> {
  const modulePath = resolve(dirnameOf(configPath), config.integrationModulePath);
  const mod = await import(modulePath);
  const impl: IntegrationModule = mod.default ?? mod;
  if (typeof impl.authenticate !== "function" || typeof impl.getJourneyState !== "function") {
    throw new Error(
      `Integration module at ${modulePath} must export authenticate() and getJourneyState().`
    );
  }
  return impl;
}

function dirnameOf(p: string): string {
  const idx = p.replace(/\\/g, "/").lastIndexOf("/");
  return idx === -1 ? "." : p.slice(0, idx);
}
