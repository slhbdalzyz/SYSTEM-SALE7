/** What a member of staff may open in the back office. The owner can do everything. */
export const PERMISSIONS = {
  reports: "لوحة التحكم والتقارير والأرباح",
  products: "الأصناف والأقسام والملصقات",
  purchasing: "المشتريات والموردين والمخزون",
  branches: "الفروع والتحويلات",
  customers: "العملاء والديون",
  offers: "العروض",
  expenses: "المصروفات",
  payroll: "الرواتب والخصومات",
  alerts: "التنبيهات",
  staff: "الموظفين وصلاحياتهم",
  devices: "أجهزة الكاشير",
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_NAMES = {
  owner: "صاحب المحل",
  manager: "مدير",
  accountant: "محاسب",
  data_entry: "مدخل بيانات",
  cashier: "كاشير",
} as const;

/** What each job can do unless the owner ticks something else for that person. */
export const ROLE_PERMISSIONS: Record<keyof typeof ROLE_NAMES, readonly Permission[]> = {
  owner: PERMISSION_KEYS,
  manager: ["reports", "products", "purchasing", "branches", "customers", "offers", "expenses", "payroll", "alerts", "staff", "devices"],
  accountant: ["reports", "purchasing", "customers", "expenses", "payroll", "alerts"],
  data_entry: ["products", "purchasing", "offers"],
  cashier: [],
};

/** The permissions a user really has: the owner has all; otherwise the person's own list, or the job's. */
export function effectivePermissions(role: string, own: readonly string[] | null | undefined): Permission[] {
  if (role === "owner") return [...PERMISSION_KEYS];
  const base = own ?? ROLE_PERMISSIONS[role as keyof typeof ROLE_NAMES] ?? [];
  return PERMISSION_KEYS.filter((p) => base.includes(p));
}

/** Kinds of line on an employee's monthly pay sheet. */
export const PAYROLL_KINDS = {
  bonus: { label: "مكافأة / إضافي", sign: 1 },
  return: { label: "مرتجع مشتريات", sign: 1 },
  purchase: { label: "مشتريات من المحل", sign: -1 },
  advance: { label: "سلفة", sign: -1 },
  late: { label: "تأخير", sign: -1 },
  absence: { label: "غياب", sign: -1 },
  unpaid_leave: { label: "إجازة بدون راتب", sign: -1 },
  deduction: { label: "خصم / جزاء", sign: -1 },
  paid_leave: { label: "إجازة براتب", sign: 0 },
  payment: { label: "صرف من الراتب", sign: 0 },
} as const;
export type PayrollKind = keyof typeof PAYROLL_KINDS;

/** A day's pay is a thirtieth of the month; a minute's is that over the working day. */
export function dayRate(salaryMinor: number): number {
  return Math.round(salaryMinor / 30);
}
export function lateAmount(salaryMinor: number, minutes: number, dayMinutes: number): number {
  return Math.round((salaryMinor / 30 / Math.max(dayMinutes, 1)) * minutes);
}
