import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDirs } from "./temp-dirs.js";

const made: string[] = [];

describe("a suite using tempDirs", () => {
  const tmp = tempDirs("aicad-temp-dirs-test-");
  it("gets fresh, distinct directories", () => {
    made.push(tmp(), tmp());
    mkdirSync(join(made[0]!, "nested", "deeper"), { recursive: true });
    writeFileSync(join(made[0]!, "nested", "deeper", "file.txt"), "x");
    expect(made[0]).not.toBe(made[1]);
    expect(made.every((d) => existsSync(d))).toBe(true);
  });
});

it("deletes them, contents included, once that suite has finished", () => {
  expect(made).toHaveLength(2);
  expect(made.filter((d) => existsSync(d))).toEqual([]);
});
