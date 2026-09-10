import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgliteResultStore } from '../src/storage/sql.store.js';
import { FileStateStore } from '../src/storage/file-state.store.js';
import { RedisStateStore } from '../src/storage/redis-state.store.js';
import type { StateStore } from '../src/storage/ports.js';
import { CONFIG } from '../src/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('PostgreSQL(PGlite) 영구 저장소', () => {
  let store: PgliteResultStore;
  beforeAll(async () => { store = new PgliteResultStore(); await store.init(); }, 60000);
  afterAll(async () => { await store.close(); });

  it('계정을 만들고 이메일·닉네임으로 찾는다', async () => {
    await store.createAccount({
      accountId: 'a1', email: 'A@Example.com', nickname: '홍길동',
      passwordHash: 'h', createdAtEpochMs: 1, nicknameChangedSeason: null,
    });
    expect((await store.findAccountByEmail('a@example.com'))?.accountId).toBe('a1');
    expect((await store.findAccountByNickname('홍길동'))?.accountId).toBe('a1');
  });

  it('닉네임은 대소문자·공백을 무시하고 유일하다 (K2)', async () => {
    await store.createAccount({ accountId: 'a2', email: 'b@x.com', nickname: 'Alice', passwordHash: 'h', createdAtEpochMs: 1, nicknameChangedSeason: null });
    await expect(store.createAccount({ accountId: 'a3', email: 'c@x.com', nickname: 'a l i c e'.replace(/ /g, ''), passwordHash: 'h', createdAtEpochMs: 1, nicknameChangedSeason: null }))
      .rejects.toThrow();
  });

  it('판 결과 이관은 멱등하다 — 같은 matchId 를 두 번 넣어도 한 번만 들어간다', async () => {
    const row = {
      matchId: 'm1', roomId: 'r1', puzzleId: 'p1', mode: 'race', difficulty: 'normal',
      limitSec: 900, rankEligible: true, endReason: 'all-finished',
      startedAtEpochMs: 1, endedAtEpochMs: 2,
      rulesSnapshot: { mode: 'race', difficulty: 'normal' },
      participants: [{ accountId: 'a1', rank: 1 }], team: null,
    };
    expect((await store.saveMatchResult(row)).inserted).toBe(true);
    expect((await store.saveMatchResult(row)).inserted).toBe(false);
    expect(await store.hasMatchResult('m1')).toBe(true);
  });

  it('룰 스냅샷이 JSONB 로 남아 브래킷 재계산의 근거가 된다', async () => {
    const list = await store.listMatchResults('a1');
    expect(list).toHaveLength(1);
    expect((list[0]!.rulesSnapshot as Record<string, unknown>)['difficulty']).toBe('normal');
  });

  it('퍼즐 풀에서 꺼내면 재고가 준다', async () => {
    for (let i = 0; i < 3; i++) {
      await store.addPuzzle({ puzzleId: `pz${i}`, difficulty: 'normal', seed: i, givens: [], solution: [], path: [], clues: 30, createdAtEpochMs: i });
    }
    expect(await store.countPuzzles('normal')).toBe(3);
    const taken = await store.takePuzzle('normal', []);
    expect(taken?.puzzleId).toBe('pz0');
    expect(await store.countPuzzles('normal')).toBe(2);
  });

  it('최근 본 퍼즐은 배정 후보에서 빠진다 (재배정 금지 · 롤링 30일)', async () => {
    const now = Date.now();
    await store.markPuzzleSeen([{ accountId: 'a1', puzzleId: 'pz1', atEpochMs: now }]);
    const seen = await store.puzzlesSeenSince(['a1'], now - 30 * 86400000);
    expect(seen).toContain('pz1');
    const next = await store.takePuzzle('normal', seen);
    expect(next?.puzzleId).toBe('pz2');
  });

  it('기록은 브래킷별 최소값 순으로 나온다', async () => {
    await store.addRecords([
      { bracket: 'race:normal', matchId: 'm1', puzzleId: 'p', adjustedFinishSec: 500, atEpochMs: 1, holders: [], mode: 'race' },
      { bracket: 'race:normal', matchId: 'm2', puzzleId: 'p', adjustedFinishSec: 300, atEpochMs: 2, holders: [], mode: 'race' },
    ]);
    expect((await store.topRecords('race:normal', 10)).map((r) => r.matchId)).toEqual(['m2', 'm1']);
  });

  it('입력 간격 요약은 원본 타임스탬프 없이 한 행으로 남는다', async () => {
    await store.addInputSummaries([{ matchId: 'm1', accountId: 'a1', inputs: 54, medianGapMs: 1200, varianceMs2: 400, minGapMs: 90, p5GapMs: 200 }]);
    await store.addInputSummaries([{ matchId: 'm1', accountId: 'a1', inputs: 54, medianGapMs: 1200, varianceMs2: 400, minGapMs: 90, p5GapMs: 200 }]);
  });
});

describe('진행 중 상태 — 재시작을 견딘다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sudoku-state-'));
  const file = join(dir, 'state.json');
  it('프로세스가 죽어도 파일에서 그대로 읽어 온다', async () => {
    const a = new FileStateStore(file);
    await a.set('match:m1', { matchId: 'm1', cells: [1, 2, 3], submitsUsed: 2 });
    await a.close();
    const b = new FileStateStore(file);                    // 새 프로세스인 셈
    expect(await b.get('match:m1')).toEqual({ matchId: 'm1', cells: [1, 2, 3], submitsUsed: 2 });
    expect(await b.keys('match:')).toEqual(['match:m1']);
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('수명을 준 값은 스스로 사라진다 — 읽는 쪽이 판정하지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sudoku-ttl-'));
    const file = join(dir, 'state.json');
    const s = new FileStateStore(file);
    await s.set('session:live', { a: 1 }, 60_000);
    await s.set('session:soon', { a: 2 }, 40);
    await s.set('room:forever', { a: 3 });                  // 수명 없음

    expect(await s.get('session:soon')).toEqual({ a: 2 });
    await new Promise((r) => setTimeout(r, 80));

    expect(await s.get('session:soon')).toBeNull();          // 만료
    expect(await s.get('session:live')).toEqual({ a: 1 });
    expect(await s.get('room:forever')).toEqual({ a: 3 });
    expect((await s.keys('')).sort()).toEqual(['room:forever', 'session:live']);   // 목록에서도 빠진다
    await s.close();

    // 만료는 재시작을 견딘다 — 파일에 만료 시각이 함께 적힌다
    const again = new FileStateStore(file);
    expect(await again.get('session:soon')).toBeNull();
    expect(await again.get('session:live')).toEqual({ a: 1 });
    await again.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('같은 키에 다시 쓰면 수명도 새로 시작한다 (슬라이딩)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sudoku-ttl2-'));
    const s = new FileStateStore(join(dir, 'state.json'));
    await s.set('session:x', { n: 1 }, 60);
    await new Promise((r) => setTimeout(r, 40));
    await s.set('session:x', { n: 2 }, 60);                  // 연장
    await new Promise((r) => setTimeout(r, 40));
    expect(await s.get('session:x')).toEqual({ n: 2 });      // 첫 수명(60ms)은 이미 지났다
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('수명 개념이 없던 옛 파일도 그대로 읽는다 (v1 형식)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sudoku-v1-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ 'room:r1': { roomId: 'r1' }, 'session:s1': { a: 1 } }), 'utf8');
    const s = new FileStateStore(file);
    expect(await s.get('room:r1')).toEqual({ roomId: 'r1' });
    expect((await s.keys('')).sort()).toEqual(['room:r1', 'session:s1']);
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 분산 잠금 (storage/ports.ts 의 acquire·release·renew)
 *
 * 노드를 건너 거는 잠금의 바닥이다. **어댑터를 골라 가며 같은 시험을 돌린다** —
 * `REDIS_URL` 이 있으면 Redis 어댑터까지 포함된다. 운영에서 쓰이는 것이 그쪽이고,
 * 그쪽에는 Lua 스크립트가 있어 파일 어댑터로는 한 줄도 확인되지 않는다.
 */
describe('분산 잠금', () => {
  const adapters: { name: string; make: () => Promise<{ store: StateStore; cleanup: () => Promise<void> }> }[] = [
    {
      name: '파일',
      make: async () => {
        const dir = mkdtempSync(join(tmpdir(), 'sudoku-lock-'));
        const store = new FileStateStore(join(dir, 'state.json'));
        return { store, cleanup: async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); } };
      },
    },
  ];

  if (CONFIG.redisUrl) {
    adapters.push({
      name: 'Redis',
      make: async () => {
        const { default: Redis } = await import('ioredis');
        const ns = `locktest_${Math.random().toString(36).slice(2, 8)}`;
        const client = new Redis(CONFIG.redisUrl!);
        const store = new RedisStateStore(client as never, ns);
        return {
          store,
          cleanup: async () => { for (const k of await store.keys('')) await store.del(k); await store.close(); },
        };
      },
    });
  }

  for (const adapter of adapters) {
    describe(adapter.name, () => {
      let store: StateStore;
      let cleanup: () => Promise<void>;
      beforeAll(async () => { ({ store, cleanup } = await adapter.make()); }, 30000);
      afterAll(async () => { await cleanup?.(); });

      it('한 사람만 들어간다', async () => {
        expect(await store.acquire('k1', 'alice', 5000)).toBe(true);
        expect(await store.acquire('k1', 'bob', 5000)).toBe(false);
        await store.release('k1', 'alice');
        expect(await store.acquire('k1', 'bob', 5000)).toBe(true);
        await store.release('k1', 'bob');
      });

      it('남의 잠금은 풀지 못한다 — 토큰이 그 창을 닫는다', async () => {
        expect(await store.acquire('k2', 'alice', 5000)).toBe(true);
        await store.release('k2', 'bob');                       // 엉뚱한 토큰
        expect(await store.acquire('k2', 'bob', 5000)).toBe(false);   // 아직 alice 것이다
        await store.release('k2', 'alice');
      });

      it('수명이 끝나면 저절로 풀린다', async () => {
        expect(await store.acquire('k3', 'alice', 60)).toBe(true);
        expect(await store.acquire('k3', 'bob', 60)).toBe(false);
        await new Promise((r) => setTimeout(r, 120));
        expect(await store.acquire('k3', 'bob', 5000)).toBe(true);
        await store.release('k3', 'bob');
      });

      it('가진 사람만 수명을 늘린다', async () => {
        expect(await store.acquire('k4', 'alice', 120)).toBe(true);
        expect(await store.renew('k4', 'bob', 5000)).toBe(false);     // 남의 것은 못 늘린다
        expect(await store.renew('k4', 'alice', 5000)).toBe(true);
        await new Promise((r) => setTimeout(r, 200));
        expect(await store.acquire('k4', 'bob', 5000)).toBe(false);   // 첫 수명(120ms)은 지났지만 살아 있다
        await store.release('k4', 'alice');
      });

      it('없는 잠금은 늘릴 것도 없다', async () => {
        expect(await store.renew('k5', 'alice', 5000)).toBe(false);
      });
    });
  }
});
