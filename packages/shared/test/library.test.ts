import { describe, expect, it } from "vitest";
import { LIBRARY_TYPES, libraryFor } from "../src/library";

describe("item library", () => {
  it("reads names, units, packs and weighed items", () => {
    const g = libraryFor("grocery");
    expect(g.find((i) => i.name === "مياه 1.5 لتر")).toEqual({ name: "مياه 1.5 لتر", category: "المشروبات", unit: "قنينة", weighted: false, packUnit: "شد", packQty: 6 });
    expect(g.find((i) => i.name === "طماطم")).toMatchObject({ unit: "كيلو", weighted: true });
    expect(libraryFor("other")).toEqual(g);
  });
  it("has no item twice in a kind of shop", () => {
    for (const t of LIBRARY_TYPES) {
      const names = libraryFor(t).map((i) => i.name);
      expect(new Set(names).size, t).toBe(names.length);
    }
  });
});
