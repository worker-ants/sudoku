import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, signUp, sleep, startHarness, type Client, type Harness } from './harness.js';
import type { MatchStarted } from '@sudoku/contracts';

describe('협동 한 판 — 공유 보드 · 팀 제출 · 기여 게이트', () => {
  let h: Harness; let a: Client, b: Client;
  let puzzle: { givens: number[]; solution: number[] };
  let started: MatchStarted; let blanks: number[] = [];

  beforeAll(async () => {
    h = await startHarness();
    puzzle = await h.seedPuzzle('normal', 555001);
    a = await signUp(h, 'Ann'); b = await signUp(h, 'Ben');
    const r = await api(h, a, '/api/rooms', 'POST', {});
    const code = (r.body as { code: string }).code;
    await api(h, b, '/api/rooms/join', 'POST', { code });
    a.send({ t: 'rules:update', patch: { mode: 'coop' } });
    await a.until('room:state', (m) => m.room.rules.mode === 'coop');
    b.send({ t: 'ready:toggle' });
    await a.until('room:state', (m) => m.room.members.some((x) => x.ready));
    a.clear(); b.clear();
    a.send({ t: 'match:start' });
    started = (await a.next('match:started')).match;
    blanks = started.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  }, 120000);
  afterAll(async () => { a?.close(); b?.close(); await h?.stop(); });

  it('협동 2명은 랭크 판이다 (§2.5)', () => {
    expect(started.mode).toBe('coop');
    expect(started.rankEligible).toBe(true);
  });

  it('셀 변경이 100ms 묶음으로 전원에게 중계된다 (O4)', async () => {
    a.send({ t: 'cell:set', index: blanks[0]!, value: puzzle.solution[blanks[0]!]! });
    const relay = await b.next('cells');
    expect(relay.relay.changes[0]).toMatchObject({ index: blanks[0]!, value: puzzle.solution[blanks[0]!]!, byAccountId: a.accountId });
  });

  it('진행률이 팀 단위 하나로 오고 참가자별 커서가 얹힌다 (§2.1.1)', async () => {
    a.send({ t: 'cursor:set', index: blanks[1]! });
    await sleep(700);
    const p = await b.until('progress', (m) => m.progress.kind === 'coop' && m.progress.team.filled > 0);
    expect(p.progress.kind).toBe('coop');
    if (p.progress.kind !== 'coop') return;
    expect(p.progress.team.filled).toBeGreaterThanOrEqual(1);
    expect(p.progress.cursors.find((c) => c.accountId === a.accountId)?.index).toBe(blanks[1]!);
  });

  it('제출은 팀 단위이고 5초 취소 창이 열린다 (N5 · O3)', async () => {
    for (const i of blanks) b.send({ t: 'cell:set', index: i, value: puzzle.solution[i]! });
    await sleep(300);
    b.send({ t: 'submit:request' });
    const w = await a.next('submit:window');
    expect(w.window.state).toBe('open');
    expect(w.window.byNickname).toBe('Ben');
    expect(w.window.endsAtEpochMs - Date.now()).toBeGreaterThan(3000);
  });

  it('취소 창 동안 도착한 입력은 서버가 버린다 (O7)', async () => {
    const room = (await h.rooms.membershipOf(a.accountId))!;
    const m = h.matches.matchOfRoom(room.roomId)!;
    const before = [...m.team!.cells];
    a.send({ t: 'cell:set', index: blanks[0]!, value: 0 });
    await sleep(200);
    expect(m.team!.cells).toEqual(before);
  });

  it('누구든 취소할 수 있고 팀 전체에 10초 쿨다운이 걸린다', async () => {
    a.send({ t: 'submit:cancel' });
    const w = await a.until('submit:window', (m) => m.window.state === 'cancelled');
    expect(w.window.cancelledByNickname).toBe('Ann');
    a.send({ t: 'submit:request' });
    const n = await a.next('notice');
    expect(n.code).toBe('cooldown');
  });

  it('쿨다운이 지나면 다시 제출할 수 있고 창이 끝나면 채점된다', async () => {
    await sleep(10_200);
    a.send({ t: 'submit:request' });
    await a.until('submit:window', (m) => m.window.state === 'open');
    const fired = await a.until('submit:window', (m) => m.window.state === 'fired', 8000);
    expect(fired.window.state).toBe('fired');
    const r = await a.next('submit:result');
    expect(r.result.passed).toBe(true);
  }, 30000);

  it('팀 완주가 곧 전원 완주이고, 결과에 기여도와 게이트가 실린다', async () => {
    const ended = await a.next('match:ended', 8000);
    expect(ended.result.mode).toBe('coop');
    expect(ended.result.team!.finished).toBe(true);
    expect(ended.result.team!.teamPoint).toBeGreaterThanOrEqual(51);
    const ann = ended.result.participants.find((p) => p.accountId === a.accountId)!;
    const ben = ended.result.participants.find((p) => p.accountId === b.accountId)!;
    // Ben 이 대부분을 채웠다 — 기여는 최초 입력자에게 붙는다
    expect(ben.contribution!).toBeGreaterThan(ann.contribution!);
    expect(ben.gatePassed).toBe(true);
    expect(ann.requiredContribution).toBeGreaterThanOrEqual(5);
    // 협동은 순위를 매기지 않는다
    expect(ended.result.participants.every((p) => p.rank === 0)).toBe(true);
  });

  it('협동 기록은 판 하나가 한 줄이고 게이트 통과자 명단이 들어간다 (R9)', async () => {
    await sleep(300);
    const recs = (await api(h, a, '/api/records?bracket=coop:normal:2')).body as { holders: unknown[] }[];
    expect(recs).toHaveLength(1);
    expect(recs[0]!.holders.length).toBeGreaterThanOrEqual(1);
  });

  it('협동에는 레이팅이 없다 (§7.3)', async () => {
    expect(await h.db.getRating(a.accountId)).toBeNull();
    expect(await h.db.getRating(b.accountId)).toBeNull();
  });
});
