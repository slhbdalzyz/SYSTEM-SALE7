// Desktop licence packages: what a shop pays for a year of the Windows app, by how many tills it
// runs. The platform sets the packages; the same sums run on the platform's screen (to show the
// price before issuing) and on the server (which records it).

export interface LicensePlan {
  id: string;
  name: string;
  /** Cashier tills. Kitchen screens and price checkers don't count. */
  devices: number;
  /** One year, in dirhams (1 LYD = 1000). */
  priceMinor: number;
}

export interface LicensePlans {
  plans: LicensePlan[];
  /** One more till on top of a package, per year. */
  extraDeviceMinor: number;
  /** Percent off for paying several years at once: { "2": 10 } = 10% off two years. */
  yearDiscounts: Record<string, number>;
  /** The seller's WhatsApp, where a shop's "I want a bigger package" goes. */
  sellerPhone: string | null;
}

export const DEFAULT_LICENSE_PLANS: LicensePlans = {
  plans: [
    { id: "small", name: "صغير", devices: 1, priceMinor: 700_000 },
    { id: "medium", name: "متوسط", devices: 3, priceMinor: 1_200_000 },
    { id: "large", name: "كبير", devices: 5, priceMinor: 1_500_000 },
  ],
  extraDeviceMinor: 250_000,
  yearDiscounts: { "2": 10, "3": 15 },
  sellerPhone: null,
};

/** Rounds to a whole dinar. */
const dinar = (minor: number) => Math.round(minor / 1000) * 1000;

export interface LicenseQuote {
  plan: LicensePlan | null;
  devices: number;
  /** One year of this package with its extra tills. */
  annualMinor: number;
  discountPct: number;
  totalMinor: number;
}

/** The price of `years` of a package plus `extra` tills. An unknown package prices the tills alone. */
export function quoteLicense(s: LicensePlans, a: { planId: string | null; extra: number; years: number }): LicenseQuote {
  const plan = s.plans.find((p) => p.id === a.planId) ?? null;
  const extra = Math.max(0, Math.floor(a.extra));
  const years = Math.max(1, Math.floor(a.years));
  const annualMinor = (plan?.priceMinor ?? 0) + extra * s.extraDeviceMinor;
  const discountPct = Math.min(90, Math.max(0, s.yearDiscounts[String(years)] ?? 0));
  return { plan, devices: (plan?.devices ?? 0) + extra, annualMinor, discountPct, totalMinor: dinar((annualMinor * years * (100 - discountPct)) / 100) };
}

/** Days from `today` to `until` (both YYYY-MM-DD), counting both days. */
export function daysLeftInLicense(today: string, until: string): number {
  const ms = Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000) + 1);
}

/**
 * Moving up mid-year: the shop pays the difference between the two packages' yearly prices for
 * the days left on its key, never less than nothing.
 */
export function upgradePrice(a: { oldAnnualMinor: number; newAnnualMinor: number; today: string; until: string }): { days: number; totalMinor: number } {
  const days = daysLeftInLicense(a.today, a.until);
  const diff = Math.max(0, a.newAnnualMinor - a.oldAnnualMinor);
  return { days, totalMinor: dinar((diff * Math.min(days, 365)) / 365) };
}
