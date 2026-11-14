import { describe, expect, it } from "vitest";
import { foldVariants, sortSizes, variantBaseName, variantGrid, variantLabel } from "../src/variants";

const piece = (color: string | null, size: string | null, id = `${color}-${size}`) => ({
  id, groupId: "g", name: ["قميص بولو", color, size].filter(Boolean).join(" - "), attrs: { ...(color ? { color } : {}), ...(size ? { size } : {}) },
});

describe("variants", () => {
  it("orders sizes the way a shop hangs them", () => {
    expect(sortSizes(["XL", "M", "S", "L", "M"])).toEqual(["S", "M", "L", "XL"]);
    expect(sortSizes(["42", "38", "40.5", "40"])).toEqual(["38", "40", "40.5", "42"]);
    expect(sortSizes(["مقاس حر", "L", "40"])).toEqual(["L", "40", "مقاس حر"]);
  });

  it("finds the model's own name and the piece's colour and size", () => {
    expect(variantBaseName(piece("أسود", "L"))).toBe("قميص بولو");
    expect(variantBaseName(piece(null, "L"))).toBe("قميص بولو");
    expect(variantBaseName({ name: "قميص - أحمر - فاتح", attrs: { color: "أحمر" } })).toBe("قميص - أحمر - فاتح");
    expect(variantLabel(piece("أسود", "L"))).toBe("أسود · L");
  });

  it("lays a model out as colours by sizes", () => {
    const g = variantGrid([piece("أسود", "XL"), piece("أسود", "M"), piece("أبيض", "M")]);
    expect(g.name).toBe("قميص بولو");
    expect(g.colors).toEqual(["أسود", "أبيض"]);
    expect(g.sizes).toEqual(["M", "XL"]);
    expect(g.at("أبيض", "M")?.id).toBe("أبيض-M");
    expect(g.at("أبيض", "XL")).toBeUndefined();
  });

  it("shows each model once in a search", () => {
    const plain = { id: "x", groupId: null, attrs: null };
    const f = foldVariants([piece("أسود", "M"), plain, piece("أسود", "L"), piece("أبيض", "M")]);
    expect(f.map((e) => [e.item.id, e.count])).toEqual([["أسود-M", 3], ["x", 1]]);
  });
});
