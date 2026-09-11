import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AbmEvent } from "./types.js";

/**
 * Appends events as JSON Lines, one file per run. Output is NEVER
 * committed to any git repository — see abm/harness/README.md. This
 * module just writes local files; where they end up long-term
 * (foundation/ingestion/, eventually) is a separate, later concern.
 */
export class Recorder {
  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  async record(event: AbmEvent): Promise<void> {
    await appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }
}
