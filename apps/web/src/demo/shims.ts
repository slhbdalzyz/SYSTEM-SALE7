// Browser stand-ins for the two Node modules the API code touches, so the real routes run in the page.
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export function createHash(_alg: "sha256") {
  let data = new Uint8Array();
  return {
    update(s: string) {
      data = new TextEncoder().encode(s);
      return this;
    },
    digest(_enc: "hex") {
      return bytesToHex(sha256(data));
    },
  };
}

export function randomBytes(n: number) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return { toString: (_enc: "hex") => bytesToHex(b) };
}

// "pg": the API only calls types.setTypeParser and the Pool type at import time.
const pg = { types: { setTypeParser() {} }, Pool: class {} };
export default pg;
