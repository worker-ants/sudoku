export const CONFIG = {
  port: Number(process.env.PORT ?? 4000),
  dataDir: process.env.DATA_DIR ?? '.data',
  redisUrl: process.env.REDIS_URL ?? null,
  databaseUrl: process.env.DATABASE_URL ?? null,
  /** 시즌 0의 시작 — 고정 시각(UTC). R10 */
  seasonEpochMs: Number(process.env.SEASON_EPOCH_MS ?? Date.UTC(2026, 0, 1)),
  /** 등급별 사전 생성 풀 최소 재고 (PUZZLE §5) */
  poolMinStock: Number(process.env.POOL_MIN_STOCK ?? 3),
  disconnectGraceMs: 60_000,
  idleRoomMs: 30 * 60_000,
  sessionTtlMs: 30 * 86_400_000,
} as const;
