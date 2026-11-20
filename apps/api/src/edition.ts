// Which edition this API is running as. The cloud serves many shops; the desktop's local edition
// runs on the shop's own computer for exactly one shop, with its database on that computer's disk.
// Also imported by the in-browser demo, where there is no `process`.
export const isLocal = () => typeof process !== "undefined" && process.env?.POS_LOCAL === "1";
