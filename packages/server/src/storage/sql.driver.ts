/**
 * SQL 드라이버 (ADR-STACK S2 · §6.1)
 *
 * 영구 저장소의 SQL 은 한 벌뿐이고, 붙는 서버만 두 가지다.
 *   PgDriver      운영·통합 테스트 — 진짜 PostgreSQL 서버
 *   PgliteDriver  단위 테스트·오프라인 — WASM 으로 컴파일된 실물 PostgreSQL, 인프로세스
 *
 * 둘 다 진짜 Postgres 라 SQL·JSONB 의미가 같다. 그래서 스토어가 드라이버를 알 필요가 없고,
 * 이 파일이 두 클라이언트의 사소한 모양 차이만 흡수한다.
 */

export interface SqlDriver {
  /** DDL 처럼 파라미터 없이 여러 문장을 한 번에 보낸다 */
  exec(sql: string): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  close(): Promise<void>;
}

/** 인프로세스 PGlite. dataDir 를 주면 디스크에, 주지 않으면 메모리에 둔다. */
export class PgliteDriver implements SqlDriver {
  private db: import('@electric-sql/pglite').PGlite | null = null;
  constructor(private readonly dataDir?: string) {}

  private async open(): Promise<import('@electric-sql/pglite').PGlite> {
    if (!this.db) {
      const { PGlite } = await import('@electric-sql/pglite');
      this.db = this.dataDir ? new PGlite(this.dataDir) : new PGlite();
    }
    return this.db;
  }
  async exec(sql: string): Promise<void> { await (await this.open()).exec(sql); }
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return (await this.open()).query(sql, params as never);
  }
  async close(): Promise<void> { await this.db?.close(); this.db = null; }
}

/**
 * 진짜 PostgreSQL 서버.
 *
 * BIGINT 는 node-postgres 가 문자열로 준다 — 스토어의 매퍼가 전부 `Number(...)` 를 거치므로
 * 여기서 타입 파서를 건드리지 않는다. 53비트를 넘는 값이 들어올 자리가 없기 때문이다
 * (가장 큰 값이 epoch 밀리초다).
 */
export class PgDriver implements SqlDriver {
  private pool: import('pg').Pool | null = null;
  private readonly schema: string | null;

  /**
   * schema 를 주면 그 스키마 안에서만 논다 — 서버 하나를 여러 하네스가 나눠 쓰는 경우다.
   *
   * **소문자로 접는다.** search_path 는 시작 패킷에 따옴표 없이 실려 가고, Postgres 는
   * 따옴표 없는 식별자를 소문자로 접는다. 이름에 대문자가 남아 있으면 만들어 둔 스키마와
   * 경로가 가리키는 스키마가 갈라지고, 경로가 조용히 public 으로 떨어진다.
   */
  constructor(private readonly url: string, schema?: string | null) {
    this.schema = schema ? schema.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60) : null;
  }

  private async open(): Promise<import('pg').Pool> {
    if (!this.pool) {
      const { default: pg } = await import('pg');
      this.pool = new pg.Pool({
        connectionString: this.url, max: 10,
        ...(this.schema ? { options: `-c search_path=${this.schema},public` } : {}),
      });
      if (this.schema) await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
    }
    return this.pool;
  }

  /** 하네스가 끝나며 자기 스키마를 치운다. 스키마가 없으면 하는 일이 없다. */
  async dropSchema(): Promise<void> {
    if (!this.schema) return;
    await (await this.open()).query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
  }
  async exec(sql: string): Promise<void> { await (await this.open()).query(sql); }
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const r = await (await this.open()).query(sql, params as never[]);
    return { rows: r.rows };
  }
  async close(): Promise<void> { await this.pool?.end(); this.pool = null; }
}

/** `DATABASE_URL` 이 있으면 서버에, 없으면 인프로세스에 붙는다. */
export function driverFor(databaseUrl: string | null, dataDir?: string, schema?: string | null): SqlDriver {
  return databaseUrl ? new PgDriver(databaseUrl, schema) : new PgliteDriver(dataDir);
}
