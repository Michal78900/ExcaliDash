import { describe, expect, it } from "vitest";
import { mergeSceneElements } from "../routes/dashboard/sceneMerge";

// Custom fork: server-side element merge used by editor autosaves.
describe("mergeSceneElements", () => {
  it("unions elements by id and keeps stored-only elements in place", () => {
    const merged = mergeSceneElements(
      [{ id: "s0" }, { id: "a" }, { id: "s1" }, { id: "b" }],
      [{ id: "a" }, { id: "b" }, { id: "c" }],
    );
    expect(merged.map((el) => (el as { id: string }).id)).toEqual([
      "s0",
      "a",
      "s1",
      "b",
      "c",
    ]);
  });

  it("picks the higher version, then the lower versionNonce", () => {
    const merged = mergeSceneElements(
      [
        { id: "v", version: 3, tag: "stored" },
        { id: "n", version: 2, versionNonce: 10, tag: "stored" },
        { id: "t", version: 2, versionNonce: 5, tag: "stored" },
      ],
      [
        { id: "v", version: 2, tag: "incoming" },
        { id: "n", version: 2, versionNonce: 20, tag: "incoming" },
        { id: "t", version: 2, versionNonce: 5, tag: "incoming" },
      ],
    ) as { id: string; tag: string }[];
    expect(Object.fromEntries(merged.map((el) => [el.id, el.tag]))).toEqual({
      v: "stored",
      n: "stored",
      t: "incoming",
    });
  });

  it("orders by fractional index when every element has one", () => {
    const merged = mergeSceneElements(
      [{ id: "mid", index: "a1" }],
      [
        { id: "first", index: "a0" },
        { id: "last", index: "a2" },
      ],
    );
    expect(merged.map((el) => (el as { id: string }).id)).toEqual([
      "first",
      "mid",
      "last",
    ]);
  });

  it("tolerates a missing or malformed stored scene", () => {
    expect(mergeSceneElements(null, [{ id: "a" }])).toEqual([{ id: "a" }]);
  });
});
