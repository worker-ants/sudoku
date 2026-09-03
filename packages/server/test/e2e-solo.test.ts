import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, signUp, sleep, startHarness, type Client, type Harness } from './harness.js';

/**
 * 1인 플레이 (READY §2 조건 2 개정)
 *
 * 지키려는 것은 둘이다. **혼자서도 판이 열린다**, 그리고 **그 판은 랭킹에 닿지 않는다.**
 * 둘째를 시작 조건이 아니라 랭크 자격이 막는다는 점이 이 파일의 요지다 —
 * 인원 하한을 걷어내도 MIN_PLAYERS(레이스 3 · 협동 2)가 그대로 서 있다.
 */
describe('1인 플레이', () => {
  let h: Harness;
  let solo: Client;
  let puzzle: { givens: number[]; solution: number[]; puzzleId: string };

  beforeAll(async () => {
    h = await startHarness();
    puzzle = await h.seedPuzzle('normal');
    await h.seedPuzzle('normal', 24680);        // 정원 시험이 한 판 더 쓸 수 있다
    solo = await signUp(h, 'Solo');
  }, 180000);
  afterAll(async () => { solo?.close(); await h?.stop(); });

  let code = '';
  let matchId = '';

  it('혼자 있는 룸은 캐주얼이고, 이유가 인원으로 적힌다', async () => {
    const r = await api(h, solo, '/api/rooms', 'POST', { name: '혼자 방' });
    const room = r.body as { code: string; eligibility: { eligible: boolean; reasons: string[] } };
    code = room.code;
    expect(room.eligibility.eligible).toBe(false);
    expect(room.eligibility.reasons.some((x) => x.includes('참가 인원 1명'))).toBe(true);
  });

  it('혼자서도 시작한다 — 인원 하한이 없다', async () => {
    solo.clear();
    solo.send({ t: 'match:start' });
    const started = (await solo.next('match:started')).match;
    matchId = started.matchId;
    expect(started.rankEligible).toBe(false);
    expect(started.givens).toEqual(puzzle.givens);
  }, 30000);

  it('혼자 완주하면 그 자리에서 판이 끝난다 — 전원 완주다', async () => {
    const blanks = puzzle.givens.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
    for (const i of blanks) solo.send({ t: 'cell:set', index: i, value: puzzle.solution[i]! });
    await sleep(300);                             // cell:set 은 회신이 없다 — 서버가 받을 틈을 준다
    solo.send({ t: 'submit:request' });
    expect((await solo.next('submit:result')).result.passed).toBe(true);

    const ended = await solo.next('match:ended');
    expect(ended.result.endReason).toBe('all-finished');
    expect(ended.result.rankEligible).toBe(false);
  }, 30000);

  it('전적에는 남지만 레이팅·시즌·기록에는 오르지 않는다', async () => {
    expect(await h.db.hasMatchResult(matchId)).toBe(true);
    const rows = await h.db.listMatchResults(solo.accountId, 5);
    expect(rows).toHaveLength(1);

    expect(await h.db.getRating(solo.accountId)).toBeNull();
    const recs = (await api(h, solo, '/api/records?bracket=race:normal')).body as unknown[];
    expect(recs).toHaveLength(0);
  });

  it('정원을 1로 잠그면 아무도 들어오지 못한다', async () => {
    solo.send({ t: 'room:rematch' });
    await solo.until('room:state', (m) => m.room.phase === 'waiting');
    solo.send({ t: 'rules:update', patch: { capacity: 1 } });
    await solo.until('room:state', (m) => m.room.rules.capacity === 1);

    const other = await signUp(h, 'Other');
    const r = await api(h, other, '/api/rooms/join', 'POST', { code });
    expect(r.status).toBeGreaterThanOrEqual(400);
    other.close();
  }, 30000);
});
