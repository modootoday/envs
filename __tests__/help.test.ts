import { describe, expect, it } from "vitest";

import { GROUPS } from "../src/cli/command.js";
import { Ui, type Stream } from "../src/cli/ui.js";
import { COMMANDS, dispatch } from "../src/commands/index.js";

class Capture implements Stream {
  text = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const help = (): string => {
  const err = new Capture();
  dispatch(["--help"], {
    ui: new Ui({ stdout: new Capture(), stderr: err, color: false, env: {} }),
    env: {},
  });
  return err.text;
};

describe("the bare listing is grouped", () => {
  it("prints every heading", () => {
    const text = help();
    for (const group of GROUPS) expect(text).toContain(group);
  });

  it("prints every command exactly once, grouped or not", () => {
    // Grouping is per-command, so a new verb that names no group must still
    // reach the reader rather than fall out of the listing.
    const text = help();
    for (const command of COMMANDS) {
      const rows = text
        .split("\n")
        .filter((line) => line.trim().startsWith(`${command.name} `));
      expect([command.name, rows.length]).toEqual([command.name, 1]);
    }
  });

  it("puts the first thing to run under the first heading", () => {
    const text = help();
    expect(text.indexOf("init")).toBeLessThan(text.indexOf("export"));
    expect(text.indexOf(GROUPS[0])).toBeLessThan(text.indexOf("init"));
  });
});
