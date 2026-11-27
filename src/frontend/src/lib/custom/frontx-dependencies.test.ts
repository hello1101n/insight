import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SHARED = ["react", "react-dom", "@gears-frontx/ui-kit"];
const app = resolve(__dirname, "../../..");

function installed(from: string, name: string): string | undefined {
  const lookup = createRequire(join(from, "package.json")).resolve.paths(name);
  const found = lookup
    ?.map((modules) => join(modules, name))
    .find((dir) => existsSync(dir));
  return found && realpathSync(found);
}

describe("FrontX dashboard root", () => {
  it.each(SHARED)("runs the copy of %s that the app runs", (name) => {
    const root = installed(app, "@gears-frontx/frontx-dashboard-root");

    expect(root, "should be a workspace member").toBeDefined();
    expect(installed(root!, name), `should resolve ${name}`).toBe(
      installed(app, name)
    );
  });
});
