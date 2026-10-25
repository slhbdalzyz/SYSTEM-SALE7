// The till tells the customer screen what is in the cart. Same browser, so a BroadcastChannel is enough.
export interface DisplayLine {
  name: string;
  qty: string;
  amount: string;
}
export type DisplayState =
  | { kind: "idle"; storeName: string }
  | { kind: "cart"; storeName: string; lines: DisplayLine[]; total: string; discount: string | null; customer: string | null }
  | { kind: "paid"; storeName: string; total: string; change: string | null };

const NAME = "pos-customer-display";

export function displaySender() {
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(NAME);
  } catch {
    ch = null;
  }
  let last: DisplayState | null = null;
  // A display opened later asks for the current state.
  if (ch) ch.onmessage = (e) => e.data === "hello" && last && ch!.postMessage(last);
  return {
    send(s: DisplayState) {
      last = s;
      ch?.postMessage(s);
    },
    close() {
      ch?.close();
    },
  };
}

export function displayReceiver(on: (s: DisplayState) => void) {
  const ch = new BroadcastChannel(NAME);
  ch.onmessage = (e) => typeof e.data === "object" && on(e.data as DisplayState);
  ch.postMessage("hello");
  return () => ch.close();
}
