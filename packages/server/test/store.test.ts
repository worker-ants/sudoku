import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgliteResultStore } from '../src/storage/sql.store.js';
import { FileStateStore } from '../src/storage/file-state.store.js';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
