import { expect, test } from "bun:test";
import { join } from "node:path";
import { profilesPath } from "../src/provider/profiles";

test("a suíte usa um ASTRO_HOME temporário", () => {
  const home = process.env.ASTRO_HOME;
  expect(home).toBeDefined();
  expect(home).toContain("astro-tests-home-");
  expect(profilesPath()).toBe(join(home!, "providers.json"));
});
