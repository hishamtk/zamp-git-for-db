import { describe, expect, it } from "vitest";
import { lowestCommonAncestorId } from "../src/vcs/commits.js";

function chain(pairs: Array<[string, string | null]>): Map<string, string | null> {
  return new Map(pairs);
}

describe("lowestCommonAncestorId", () => {
  it("returns the id when both sides are the same commit", () => {
    const parents = chain([["c0", null], ["c1", "c0"]]);
    expect(lowestCommonAncestorId(parents, "c1", "c1")).toBe("c1");
  });

  it("finds the shared parent of same-base siblings", () => {
    const parents = chain([
      ["c0", null],
      ["a1", "c0"],
      ["b1", "c0"],
    ]);
    expect(lowestCommonAncestorId(parents, "a1", "b1")).toBe("c0");
  });

  it("walks past a later main head to the earlier branch point", () => {
    const parents = chain([
      ["c0", null],
      ["c1", "c0"],
      ["c2", "c1"],
      ["a1", "c1"],
      ["b1", "c2"],
    ]);
    expect(lowestCommonAncestorId(parents, "a1", "b1")).toBe("c1");
    expect(lowestCommonAncestorId(parents, "b1", "c2")).toBe("c2");
    expect(lowestCommonAncestorId(parents, "c2", "c0")).toBe("c0");
  });

  it("returns null when the graphs do not meet", () => {
    const parents = chain([
      ["a", null],
      ["b", null],
    ]);
    expect(lowestCommonAncestorId(parents, "a", "b")).toBeNull();
  });
});
