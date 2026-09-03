import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * 접속 URL 조립 (config.ts)
 *
 * CONFIG 는 모듈 최상위 상수라 import 시점에 굳는다. 그래서 환경을 바꿔 가며 보려면
 * 매번 모듈 캐시를 비우고 다시 import 해야 한다.
 */
const PARTS = ['DATABASE_URL', 'REDIS_URL', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
  'POSTGRES_DB', 'POSTGRES_PORT', 'POSTGRES_HOST', 'REDIS_PORT', 'REDIS_HOST'] as const;

const load = async (env: Partial<Record<(typeof PARTS)[number], string | undefined>>) => {
  for (const k of PARTS) delete process.env[k];
  // Object.assign 으로 넣으면 undefined 가 문자열 "undefined" 로 들어간다 — 키를 아예 뺀다
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  vi.resetModules();
  return (await import('../src/config.js')).CONFIG;
};

describe('접속 URL 조립', () => {
  beforeEach(() => { vi.resetModules(); });

  const full = {
    POSTGRES_USER: 'sudoku', POSTGRES_PASSWORD: 'sudoku',
    POSTGRES_DB: 'sudoku', POSTGRES_PORT: '5433',
  };

  it('조각이 다 있으면 URL 을 만든다 — 호스트 기본값은 127.0.0.1', async () => {
    const c = await load(full);
    expect(c.databaseUrl).toBe('postgres://sudoku:sudoku@127.0.0.1:5433/sudoku');
  });

  it('POSTGRES_HOST 를 주면 그것을 쓴다', async () => {
    const c = await load({ ...full, POSTGRES_HOST: 'db.internal' });
    expect(c.databaseUrl).toBe('postgres://sudoku:sudoku@db.internal:5433/sudoku');
  });

  it('예약문자가 든 비밀번호를 인코딩한다 — 조립을 코드로 옮긴 이유다', async () => {
    const c = await load({ ...full, POSTGRES_PASSWORD: 'p@ss:w/rd?' });
    expect(c.databaseUrl).toBe('postgres://sudoku:p%40ss%3Aw%2Frd%3F@127.0.0.1:5433/sudoku');
    // 뒤쪽 호스트·포트가 비밀번호에 먹히지 않았다
    expect(new URL(c.databaseUrl!).port).toBe('5433');
    expect(new URL(c.databaseUrl!).password).toBe('p%40ss%3Aw%2Frd%3F');
  });

  it('조각이 하나라도 없으면 null — 반쪽 URL 대신 PGlite 로 간다', async () => {
    expect((await load({ ...full, POSTGRES_PASSWORD: undefined })).databaseUrl).toBeNull();
    expect((await load({})).databaseUrl).toBeNull();
  });

  it('빈 문자열은 없는 것으로 친다 — compose·CI 가 빈 값을 넘기는 일이 있다', async () => {
    expect((await load({ ...full, POSTGRES_DB: '' })).databaseUrl).toBeNull();
  });

  it('DATABASE_URL 을 주면 조각을 무시하고 그것이 이긴다 — 관리형 DB 경로', async () => {
    const c = await load({ ...full, DATABASE_URL: 'postgres://u:p@managed.example:5432/prod' });
    expect(c.databaseUrl).toBe('postgres://u:p@managed.example:5432/prod');
  });

  it('통째 URL 이 망가져 있으면 변수 이름과 함께 즉시 멈춘다', async () => {
    // 옛 .env 에 보간이 남아 있던 실제 사고 — 그때는 ioredis 안쪽 스택으로 터졌다
    await expect(load({ REDIS_URL: 'redis://127.0.0.1:${REDIS_PORT}' }))
      .rejects.toThrow(/REDIS_URL 가 URL 이 아니다/);
    await expect(load({ DATABASE_URL: '망가진값' }))
      .rejects.toThrow(/DATABASE_URL 가 URL 이 아니다/);
  });

  it('Redis 도 같은 규칙이다', async () => {
    expect((await load({ REDIS_PORT: '6380' })).redisUrl).toBe('redis://127.0.0.1:6380');
    expect((await load({ REDIS_PORT: '6380', REDIS_HOST: 'cache' })).redisUrl).toBe('redis://cache:6380');
    expect((await load({})).redisUrl).toBeNull();
    expect((await load({ REDIS_PORT: '6380', REDIS_URL: 'rediss://managed:6379' })).redisUrl)
      .toBe('rediss://managed:6379');
  });
});
