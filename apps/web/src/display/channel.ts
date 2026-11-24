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

/** The shop's slides, sent once when the till opens and again when they change. */
export interface DisplayAdsMsg { kind: "ads"; seconds: number; duringSale: boolean; slides: { id: string; title: string; text: string; image: string | null; bg: string }[] }

const NAME = "pos-customer-display";

export function displaySender() {
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(NAME);
  } catch {
    ch = null;
  }
  let last: DisplayState | null = null;
  let ads: DisplayAdsMsg | null = null;
  // A display opened later asks for the current state.
  if (ch) ch.onmessage = (e) => {
    if (e.data !== "hello") return;
    if (ads) ch!.postMessage(ads);
    if (last) ch!.postMessage(last);
  };
  return {
    send(s: DisplayState) {
      last = s;
      ch?.postMessage(s);
    },
    ads(a: DisplayAdsMsg) {
      ads = a;
      ch?.postMessage(a);
    },
    close() {
      ch?.close();
    },
  };
}

export function displayReceiver(on: (s: DisplayState) => void, onAds?: (a: DisplayAdsMsg) => void) {
  const ch = new BroadcastChannel(NAME);
  ch.onmessage = (e) => {
    if (typeof e.data !== "object" || !e.data) return;
    if ((e.data as { kind: string }).kind === "ads") onAds?.(e.data as DisplayAdsMsg);
    else on(e.data as DisplayState);
  };
  ch.postMessage("hello");
  return () => ch.close();
}
