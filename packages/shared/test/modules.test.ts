import { describe, expect, it } from "vitest";
import { MODULES, shopModules } from "../src/modules";

describe("shop features", () => {
  it("starts each kind of shop with its own features", () => {
    expect(shopModules("clothing")).toMatchObject({ variants: true, recipes: false, serials: false });
    expect(shopModules("electronics")).toMatchObject({ serials: true, repairs: true, variants: false });
    expect(shopModules(undefined)).toMatchObject({ weighed: true, expiry: true, variants: false });
  });
  it("follows what the owner turned on or off", () => {
    const m = shopModules("electronics", { variants: true, repairs: false, junk: true });
    expect(m).toMatchObject({ variants: true, repairs: false, serials: true });
    expect(Object.keys(m).sort()).toEqual(MODULES.map((x) => x.key).sort());
  });
});
