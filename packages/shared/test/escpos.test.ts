import { describe, expect, it } from "vitest";
import { CUT, OPEN_DRAWER, rasterCommands, receiptJob, toMonochrome, trimBottom } from "../src";

function rgba(w: number, h: number, black: (x: number, y: number) => boolean) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = black(x, y) ? 0 : 255;
      a.set([v, v, v, 255], (y * w + x) * 4);
    }
  return a;
}

describe("escpos", () => {
  it("packs dark pixels into bits, left pixel first", () => {
    const b = toMonochrome(rgba(10, 1, (x) => x === 0 || x === 9), 10, 1);
    expect(b.width).toBe(16);
    expect([...b.data]).toEqual([0b10000000, 0b01000000]);
  });
  it("treats transparent pixels as paper", () => {
    const b = toMonochrome(new Uint8ClampedArray(8 * 4), 8, 1);
    expect(b.data[0]).toBe(0);
  });
  it("trims empty rows at the bottom", () => {
    const b = toMonochrome(rgba(8, 100, (_x, y) => y < 10), 8, 100);
    expect(trimBottom(b, 2).height).toBe(12);
  });
  it("splits tall images into GS v 0 bands", () => {
    const b = toMonochrome(rgba(16, 300, () => true), 16, 300);
    const cmds = rasterCommands(b, 256);
    expect(cmds).toHaveLength(4);
    expect([...cmds[0]]).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, 0, 1]); // 2 bytes wide, 256 rows
    expect([...cmds[2]]).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, 44, 0]);
    expect(cmds[3].length).toBe(2 * 44);
  });
  it("can open the drawer with nothing to print", () => {
    const job = receiptJob(null, { openDrawer: true });
    expect([...job]).toEqual([0x1b, 0x40, ...OPEN_DRAWER]);
  });
  it("ends a receipt with a cut", () => {
    const job = receiptJob(toMonochrome(rgba(8, 1, () => true), 8, 1));
    expect([...job.slice(-CUT.length)]).toEqual([...CUT]);
  });
});
