// PGlite (PostgreSQL compiled to WebAssembly) behind the same small surface the routes use from
// a pg pool: query() and connect(). Used by the in-browser demo and by the desktop's local edition.
// PGlite has one connection, so callers take turns: a transaction (connect … release) holds it
// until it is released, and every other query waits for it, like a pool of size one.

interface PgliteLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
}

type Result = { rows: any[]; rowCount: number }; // eslint-disable-line @typescript-eslint/no-explicit-any

export class PgliteDb {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private pg: PgliteLike) {}
  private async raw(sql: string, params: unknown[] = []): Promise<Result> {
    const r = await this.pg.query(sql, params);
    return { rows: r.rows as any[], rowCount: Math.max(r.rows.length, r.affectedRows ?? 0) }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
  query(sql: string, params?: unknown[]) {
    return this.lock(() => this.raw(sql, params));
  }
  connect() {
    return new Promise<{ query: (sql: string, params?: unknown[]) => Promise<Result>; release: () => void }>((resolve) => {
      void this.lock(
        () =>
          new Promise<void>((done) => {
            resolve({ query: (s, p) => this.raw(s, p), release: () => done() });
          }),
      );
    });
  }
  /** Waits for whatever is running, so nothing is cut off half way (before closing the database). */
  idle() {
    return this.lock(async () => undefined);
  }
}

/** Same conversions as the pg pool in db.ts: bigint and numeric as numbers, a date as "YYYY-MM-DD". */
export const pgliteParsers = { 20: (v: string) => Number(v), 1700: (v: string) => Number(v), 1082: (v: string) => v };
