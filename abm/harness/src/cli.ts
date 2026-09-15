#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { chromium } from "playwright";
import { loadConfig, loadIntegrationModule } from "./config.js";
import { runAgent } from "./runAgent.js";
import { Recorder } from "./recorder.js";
import { rngForAgent, uniform } from "./rng.js";
import type { AgentParameters, SyntheticAccount } from "./types.js";

/**
 * Entry point: `node dist/cli.js --config config.json --experiment
 * guided-vs-unguided-v1 --condition guided --count 5 --accounts
 * accounts.json [--baseline] [--run-id <id>]`
 *
 * Runs agents sequentially (see abm/README.md — parallelism later is a
 * concurrency-limit change, not a rearchitecture, since every agent is
 * already independent). Population/parameter distributions here match
 * abm/experiments/guided-vs-unguided/definition.md — if you're running a
 * different experiment, its own definition governs, not this file.
 */

const PARAM_NAMES = [
  "goal_seeking",
  "exploration",
  "visual_sensitivity",
  "time_cost",
  "abandonment_propensity",
] as const;

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      experiment: { type: "string" },
      condition: { type: "string" },
      count: { type: "string", default: "5" },
      accounts: { type: "string" },
      "run-id": { type: "string" },
      baseline: { type: "boolean", default: false },
      // Per-agent recording — OFF by default, opt-in only: video (.webm) is
      // for watching what an agent did, trace (.zip, Playwright Trace
      // Viewer: DOM snapshot per action, network, console) is for
      // diagnosing why. Sidecar files under runs/<run-id>/<agent-id>.*,
      // never committed, joined to the JSONL by run_id + agent_id.
      record: { type: "string" },
      // Population seed — defaults to the run id. Pass another run's id to
      // re-draw exactly that run's agent parameters under a different
      // policy/build: calibration rounds are only comparable when the
      // agents are the same (learned the hard way on 2026-09-15, when
      // three rounds were compared with three different populations).
      "population-seed": { type: "string" },
    },
  });

  if (!values.config || !values.experiment || !values.condition || !values.accounts) {
    console.error(
      "Usage: cli --config <path> --experiment <id> --condition <guided|unguided> --accounts <path> [--count N] [--run-id id] [--baseline] [--record video|trace|both] [--population-seed <run-id>]"
    );
    process.exit(1);
  }

  const config = await loadConfig(values.config);
  const integration = await loadIntegrationModule(values.config, config);
  const accounts: SyntheticAccount[] = JSON.parse(await readFile(values.accounts, "utf8"));
  const count = parseInt(values.count!, 10);
  const runId = values["run-id"] ?? randomUUID();
  const record = values.record ?? "off";
  if (!["off", "video", "trace", "both"].includes(record)) {
    throw new Error(`--record must be video, trace or both (got "${record}").`);
  }
  const recordVideo = record === "video" || record === "both";
  const recordTrace = record === "trace" || record === "both";
  const recordingDir = `${config.outputDir}/${runId}`;
  if (record !== "off") await mkdir(recordingDir, { recursive: true });

  const populationSeed = values["population-seed"] ?? runId;
  const population = buildPopulation(runId, populationSeed, count, values.baseline!);
  if (populationSeed !== runId) console.log(`population re-drawn from seed "${populationSeed}"`);
  if (population.length > accounts.length) {
    throw new Error(
      `Population needs ${population.length} accounts, only ${accounts.length} provided.`
    );
  }

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < population.length; i++) {
      const agentId = population[i].agentId;
      const account = accounts[i];
      const recorder = new Recorder(`${config.outputDir}/${runId}.jsonl`);
      await recorder.init();

      console.log(`[${i + 1}/${population.length}] agent ${agentId} (${values.condition})`);
      const context = await browser.newContext({
        baseURL: config.baseUrl,
        viewport: { width: 1280, height: 800 },
        ...(recordVideo ? { recordVideo: { dir: recordingDir, size: { width: 1280, height: 800 } } } : {}),
      });
      if (recordTrace) await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      try {
        await runAgent({
          experimentId: values.experiment!,
          runId,
          agentId,
          condition: values.condition!,
          params: population[i].params,
          account,
          config,
          integration,
          page,
          recorder,
        });
      } catch (err) {
        console.error(`Agent ${agentId} failed:`, err);
      } finally {
        if (recordTrace) {
          await context.tracing.stop({ path: `${recordingDir}/${agentId}.trace.zip` }).catch(() => {});
        }
        const video = recordVideo ? page.video() : null;
        await context.close();
        if (video) {
          // Playwright names the file by an internal id; rename to the agent.
          const tmp = await video.path().catch(() => null);
          if (tmp) await rename(tmp, `${recordingDir}/${agentId}.webm`).catch(() => {});
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`Done. Events written to ${config.outputDir}/${runId}.jsonl`);
}

function buildPopulation(
  runId: string,
  populationSeed: string,
  count: number,
  includeBaseline: boolean
): { agentId: string; params: AgentParameters }[] {
  const population: { agentId: string; params: AgentParameters }[] = [];

  if (includeBaseline) {
    const params: AgentParameters = {};
    for (const name of PARAM_NAMES) params[name] = 0.5;
    population.push({ agentId: `${runId}-baseline`, params });
  }

  for (let i = 0; i < count; i++) {
    const agentId = `${runId}-agent-${i}`;
    // Parameters come from the population seed (so they can be reused
    // across runs); the per-step decision RNG in runAgent stays keyed to
    // the real run id.
    const rng = rngForAgent(populationSeed, `${populationSeed}-agent-${i}`);
    const params: AgentParameters = {};
    for (const name of PARAM_NAMES) params[name] = uniform(rng, 0, 1);
    population.push({ agentId, params });
  }

  return population;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
