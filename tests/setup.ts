/** Isola a suíte do ~/.astro real do desenvolvedor (ASTRO_HOME temporário). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ASTRO_HOME = mkdtempSync(join(tmpdir(), "astro-tests-home-"));
