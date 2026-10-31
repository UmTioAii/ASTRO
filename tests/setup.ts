/** Isola a suíte do ~/.astro real do desenvolvedor (ASTRO_HOME temporário). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ASTRO_HOME = mkdtempSync(join(tmpdir(), "astro-tests-home-"));
// Fixtures locais usam 127.0.0.1; o opt-in explícito mantém o default de produção estrito.
process.env.ASTRO_ALLOW_PRIVATE_URLS = "1";
