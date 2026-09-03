/**
 * 설정 한 자리.
 *
 * **DATABASE_URL·REDIS_URL 은 조각에서 조립한다** — `.env` 에 URL 을 통째로 적지 않는다.
 * 같은 자격증명이 URL 안에 한 번, docker-compose 가 읽는 POSTGRES_* 에 또 한 번 적히면
 * 두 곳이 언젠가 갈라진다. 조각을 유일한 출처로 두고 합치는 일만 여기서 한다.
 *
 * 조립을 `.env` 의 `${...}` 보간에 맡기지 않는 이유 둘.
 *   ① **보간을 푸는지가 로더마다 다르다.** docker compose 와 셸 `source` 는 풀지만
 *      dotenv 단독과 `node --env-file` 은 풀지 않아 URL 이 문자 그대로 들어간다.
 *      조립이 코드에 있으면 로더가 무엇이든 상관없다.
 *   ② **보간은 URL 인코딩을 하지 않는다.** 비밀번호에 `@`·`:`·`/` 가 들어가면 조용히
 *      깨진 URL 이 만들어진다. 여기서는 예약문자를 인코딩한다.
 *
 * **통째 URL 도 계속 받는다.** 관리형 Postgres 는 대개 DATABASE_URL 하나만 주므로,
 * 그것이 있으면 이긴다. 조각은 없을 때만 본다.
 */

/** 빈 문자열은 없는 것으로 친다 — compose 나 CI 가 빈 값을 넘기는 일이 있다 */
const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v;
};

/**
 * 통째로 받은 URL 은 여기서 한 번 본다.
 *
 * 안 그러면 망가진 값이 ioredis·pg 안쪽까지 흘러가 `TypeError: Invalid URL` 스택으로
 * 나온다 — 어느 환경변수가 문제인지 안 나온다. 실제로 겪었다: 옛 `.env` 에 남아 있던
 * `redis://127.0.0.1:${REDIS_PORT}` 가 그대로 넘어갔다.
 */
function checkUrl(name: string, value: string): string {
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} 가 URL 이 아니다: ${JSON.stringify(value)} — .env 를 확인하라`);
  }
  return value;
}

function postgresUrl(): string | null {
  const direct = env('DATABASE_URL');
  if (direct) return checkUrl('DATABASE_URL', direct);

  const user = env('POSTGRES_USER');
  const pass = env('POSTGRES_PASSWORD');
  const db = env('POSTGRES_DB');
  const port = env('POSTGRES_PORT');
  // 조각이 하나라도 없으면 조립하지 않는다. 반쪽 URL 로 붙으려다 실패하는 것보다
  // 인프로세스 PGlite 로 도는 편이 낫다 — 그것이 기본 개발 경로다.
  if (!user || !pass || !db || !port) return null;

  const host = env('POSTGRES_HOST') ?? '127.0.0.1';
  const e = encodeURIComponent;
  return `postgres://${e(user)}:${e(pass)}@${host}:${port}/${e(db)}`;
}

function redisUrl(): string | null {
  const direct = env('REDIS_URL');
  if (direct) return checkUrl('REDIS_URL', direct);
  const port = env('REDIS_PORT');
  if (!port) return null;
  return `redis://${env('REDIS_HOST') ?? '127.0.0.1'}:${port}`;
}

export const CONFIG = {
  port: Number(process.env.PORT ?? 4000),
  dataDir: process.env.DATA_DIR ?? '.data',
  redisUrl: redisUrl(),
  databaseUrl: postgresUrl(),
  /** 시즌 0의 시작 — 고정 시각(UTC). R10 */
  seasonEpochMs: Number(process.env.SEASON_EPOCH_MS ?? Date.UTC(2026, 0, 1)),
  /** 등급별 사전 생성 풀 최소 재고 (PUZZLE §5) */
  poolMinStock: Number(process.env.POOL_MIN_STOCK ?? 3),
  disconnectGraceMs: 60_000,
  idleRoomMs: 30 * 60_000,
  sessionTtlMs: 30 * 86_400_000,
} as const;
