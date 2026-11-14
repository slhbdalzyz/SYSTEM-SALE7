import { describe, expect, it } from "vitest";
import { kitchenDelta, recipeCost, recipeUsage, sentSnapshot } from "../src/restaurant";

describe("kitchen tickets", () => {
  it("sends everything the first time, then only what changed", () => {
    const lines = [{ key: "a", name: "شاورما", qtyMilli: 2000 }, { key: "b", name: "قهوة", qtyMilli: 1000, note: "سكر قليل" }];
    expect(kitchenDelta(lines, {})).toEqual([{ name: "شاورما", qtyMilli: 2000, note: null }, { name: "قهوة", qtyMilli: 1000, note: "سكر قليل" }]);
    const sent = sentSnapshot(lines);
    expect(kitchenDelta(lines, sent)).toEqual([]);
    const more = [{ ...lines[0], qtyMilli: 3000 }, { key: "c", name: "بيتزا", qtyMilli: 1000 }];
    expect(kitchenDelta(more, sent)).toEqual([
      { name: "شاورما", qtyMilli: 1000, note: null },
      { name: "بيتزا", qtyMilli: 1000, note: null },
      { name: "قهوة", qtyMilli: 1000, note: "سكر قليل", cancelled: true },
    ]);
  });

  it("cancels a lowered quantity, and resends a dish whose note changed", () => {
    const sent = sentSnapshot([{ key: "a", name: "برغر", qtyMilli: 3000 }]);
    expect(kitchenDelta([{ key: "a", name: "برغر", qtyMilli: 1000 }], sent)).toEqual([{ name: "برغر", qtyMilli: 2000, note: null, cancelled: true }]);
    expect(kitchenDelta([{ key: "a", name: "برغر", qtyMilli: 3000, note: "بدون بصل" }], sent)).toEqual([
      { name: "برغر", qtyMilli: 3000, note: null, cancelled: true },
      { name: "برغر", qtyMilli: 3000, note: "بدون بصل" },
    ]);
  });
});

describe("recipes", () => {
  const recipes = new Map([["latte", [{ ingredientId: "milk", qtyMilli: 200_000 }, { ingredientId: "coffee", qtyMilli: 18_000 }]]]);
  it("takes the ingredients out instead of the dish", () => {
    const u = recipeUsage([{ productId: "latte", baseMilli: 2000 }, { productId: "water", baseMilli: 1000 }, { productId: "latte", baseMilli: 1000 }], recipes);
    expect(Object.fromEntries(u)).toEqual({ milk: 600_000, coffee: 54_000, water: 1000 });
  });
  it("costs a dish from its ingredients", () => {
    // Milk 4 dirham a ml (4 LYD a litre), coffee 60 dirham a gram.
    expect(recipeCost(recipes.get("latte")!, new Map([["milk", 4], ["coffee", 60]]))).toBe(800 + 1080);
  });
});
