import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, signUp, sleep, startHarness, type Client, type Harness } from './harness.js';
import type { MatchStarted } from '@sudoku/contracts';

describe('레이스 한 판 — 로그인부터 결과까지', () => {
  let h: Harness;
  let host: Client, guest: Client, third: Client;
  let puzzle: { givens: number[]; solution: number[]; puzzleId: string };

  beforeAll(async () => {
    h = await startHarness();
    puzzle = await h.seedPuzzle('normal');
    host = await signUp(h, 'Host');
    guest = await signUp(h, 'Guest');
    third = await signUp(h, 'Third');
  }, 120000);
  afterAll(async () => { host?.close(); guest?.close(); third?.close(); await h?.stop(); });

  let code = '';

  it('룸을 만들면 코드가 6자리이고 혼동 문자가 없다 (L2)', async () => {
    const r = await api(h, host, '/api/rooms', 'POST', { name: '테스트 방' });
    expect(r.status).toBe(201);
    const room = r.body as { code: string; members: unknown[]; eligibility: { eligible: boolean } };
    code = room.code;
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(room.members).toHaveLength(1);
  });

  it('코드로 참가한다 — 3명이 되면 랭크 판이 된다 (§2.5)', async () => {
    await api(h, guest, '/api/rooms/join', 'POST', { code });
    const r = await api(h, third, '/api/rooms/join', 'POST', { code });
    const room = r.body as { members: unknown[]; eligibility: { eligible: boolean; reasons: string[] } };
    expect(room.members).toHaveLength(3);
    expect(room.eligibility.eligible).toBe(true);
  });

  it('진행 중이 아닌 다른 룸에 참가하면 이전 룸에서 빠진다 — 원칙 1', async () => {
    const solo = await signUp(h, 'Solo');
    await api(h, solo, '/api/rooms', 'POST', {});
    const before = await api(h, solo, '/api/rooms/mine');
    expect(before.body).not.toBeNull();
    await api(h, solo, '/api/rooms/join', 'POST', { code });
    const after = (await api(h, solo, '/api/rooms/mine')).body as { code: string };
    expect(after.code).toBe(code);
    solo.send({ t: 'room:leave' });
    await sleep(150);
    solo.close();
  });

  it('게스트가 준비하지 않으면 시작할 수 없다 (시작 조건 3)', async () => {
    host.send({ t: 'match:start' });
    const n = await host.next('notice');
    expect(n.code).toBe('cannot-start');
    expect(n.text).toContain('준비하지 않았습니다');
  });

  it('룰을 바꾸면 전원 준비가 풀리고 무엇이 바뀌었는지 알려준다 (§3.1)', async () => {
    guest.send({ t: 'ready:toggle' });
    await guest.until('room:state', (m) => m.room.members.some((x) => x.ready));
    host.send({ t: 'rules:update', patch: { difficulty: 'hard' } });
    const cleared = await guest.next('ready:cleared');
    expect(cleared.changes.join()).toContain('난이도');
    expect(cleared.changes.join()).toContain('제한 시간');   // 표준값 따름이 함께 움직인다
    const st = await guest.until('room:state', (m) => m.room.rules.difficulty === 'hard');
    expect(st.room.members.every((m) => !m.ready)).toBe(true);
  });

  it('힌트를 허용하면 랭크가 풀리고 이유가 이름으로 뜬다', async () => {
    host.send({ t: 'rules:update', patch: { hintsAllowed: true } });
    const st = await host.until('room:state', (m) => m.room.rules.hintsAllowed);
    expect(st.room.eligibility.eligible).toBe(false);
    expect(st.room.eligibility.reasons.join()).toContain('힌트 허용');
  });

  it('"랭크 판으로 맞추기"가 세 항목만 되돌린다 (G1)', async () => {
    host.send({ t: 'rules:preset' });
    const st = await host.until('room:state', (m) => !m.room.rules.hintsAllowed);
    expect(st.room.eligibility.eligible).toBe(true);
    expect(st.room.rules.difficulty).toBe('hard');     // 난이도는 건드리지 않는다
    expect(st.room.rules.hintsAllowed).toBe(false);
  });

  let started: MatchStarted;

  it('전원 준비 후 시작하면 원본 단서만 내려온다 — 정답은 오지 않는다', async () => {
    // 인박스를 먼저 비운다 — until 은 남아 있던 옛 room:state 에도 걸리므로,
    // 비우지 않으면 룰 변경이 적용되기 전에 다음 단계로 넘어간다.
    host.clear(); guest.clear(); third.clear();
    host.send({ t: 'rules:update', patch: { difficulty: 'normal' } });
    await host.until('room:state', (m) => m.room.rules.difficulty === 'normal');
    host.clear();
    for (const c of [guest, third]) c.send({ t: 'ready:toggle' });
    await host.until('room:state', (m) => m.room.members.filter((x) => x.ready).length === 2);
    host.clear(); guest.clear(); third.clear();
    host.send({ t: 'match:start' });
    const m = await host.next('match:started');
    started = m.match;
    expect(started.givens).toHaveLength(81);
    expect(started.givens.filter((v) => v > 0).length).toBeLessThan(81);
    expect(JSON.stringify(m)).not.toContain(puzzle.solution.join(''));
    expect(started.rankEligible).toBe(true);
  });

  it('진행률 방송이 500ms 주기로 온다 — 채운 칸 수·완주 여부 (D10 이후 두 값이다)', async () => {
    const blanks = started.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    guest.send({ t: 'cell:set', index: blanks[0]!, value: puzzle.solution[blanks[0]!]! });
    await sleep(700);
    const p = await guest.next('progress');
    expect(p.progress.kind).toBe('race');
    if (p.progress.kind !== 'race') return;
    const me = p.progress.participants.find((x) => x.accountId === guest.accountId)!;
    expect(me.filled).toBeGreaterThanOrEqual(1);
    // 오답 제출 횟수는 항상 0이라 방송에서 뺐다 (AREA-PLAY §2.1 · D10)
    expect(Object.keys(me).sort()).toEqual(['accountId', 'connected', 'filled', 'finished', 'left']);
  });

  it('레이스는 남의 입력이 내 보드에 닿지 않는다', async () => {
    const m = h.matches.matchOfRoom((await h.rooms.membershipOf(host.accountId))!.roomId)!;
    const blanks = started.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    expect(m.participants.get(host.accountId)!.cells[blanks[0]!]).toBe(0);
    expect(m.participants.get(guest.accountId)!.cells[blanks[0]!]).toBe(puzzle.solution[blanks[0]!]);
  });

  it('빈칸이 남으면 제출이 막힌다', async () => {
    host.send({ t: 'submit:request' });
    const n = await host.next('notice');
    expect(n.text).toContain('빈칸');
  });

  it('힌트는 비허용 판에서 거부된다', async () => {
    host.send({ t: 'hint:request' });
    const n = await host.next('notice');
    expect(n.code).toBe('hints-not-allowed');
  });

  it('다 채우고 제출하면 통과하고 완주 시각이 경과 초로 온다 (D8)', async () => {
    const blanks = started.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    for (const i of blanks) host.send({ t: 'cell:set', index: i, value: puzzle.solution[i]! });
    await sleep(300);
    host.send({ t: 'submit:request' });
    const r = await host.next('submit:result');
    expect(r.result.passed).toBe(true);            // 실패 갈래가 없다 (D10 · N6)
    expect(r.result.finishedAtElapsedSec).toBeGreaterThanOrEqual(0);
    expect(r.result.finishedAtElapsedSec).toBeLessThan(900);
  });

  it('완주 뒤에는 입력을 받지 않는다', async () => {
    const room = (await h.rooms.membershipOf(host.accountId))!;
    const m = h.matches.matchOfRoom(room.roomId)!;
    const before = [...m.participants.get(host.accountId)!.cells];
    host.send({ t: 'cell:set', index: 0, value: 9 });
    await sleep(150);
    expect(m.participants.get(host.accountId)!.cells).toEqual(before);
  });

  it('전원 완주하면 판이 끝나고 결과에 정답이 공개된다 (E3)', async () => {
    const blanks = started.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    // 완주 시각은 초 단위라, 순위가 결정적으로 갈리게 간격을 벌린다.
    // (같은 초에 통과하면 공동 순위가 되는 것이 정상이다 — §4.1의 6번 키)
    for (const c of [guest, third]) {
      await sleep(1200);
      for (const i of blanks) c.send({ t: 'cell:set', index: i, value: puzzle.solution[i]! });
      await sleep(200);
      c.send({ t: 'submit:request' });
      const r = await c.next('submit:result');
      expect(r.result.passed).toBe(true);
    }
    const ended = await host.next('match:ended', 8000);
    expect(ended.result.endReason).toBe('all-finished');
    expect(ended.result.solutionRevealed).toEqual(puzzle.solution);
    expect(ended.result.participants).toHaveLength(3);
    const ranks = ended.result.participants.map((p) => p.rank).sort();
    expect(ranks).toEqual([1, 2, 3]);
    const first = ended.result.participants.find((p) => p.rank === 1)!;
    expect(first.rankPoint).toBe(100);
    expect(first.accountId).toBe(host.accountId);     // 가장 먼저 통과했다
  });

  it('결과가 영구 저장소에 남고 랭킹이 오른다', async () => {
    await sleep(300);
    const hist = (await api(h, host, '/api/history')).body as unknown[];
    expect(hist).toHaveLength(1);
    // 랭킹 화면이 의존하는 모양을 통째로 고정한다.
    // `season`(순위표 배열)을 시즌 번호가 덮어써 화면이 죽은 적이 있다 — 배열인지까지 본다.
    const rk = (await api(h, host, '/api/rankings')).body as
      { rating: unknown[]; season: { nickname: string; points: number }[]; seasonIndex: number; brackets: string[] };
    expect(Array.isArray(rk.rating)).toBe(true);
    expect(Array.isArray(rk.season)).toBe(true);
    expect(Array.isArray(rk.brackets)).toBe(true);
    expect(typeof rk.seasonIndex).toBe('number');
    expect(rk.season.length).toBeGreaterThan(0);        // 방금 판이 시즌 포인트로 올라갔다
    expect(rk.season.every((x) => typeof x.nickname === 'string' && typeof x.points === 'number')).toBe(true);
    const rating = await h.db.getRating(host.accountId);
    expect(rating).not.toBeNull();
    expect(rating!.rankedMatches).toBe(1);
    expect(rating!.rating).toBeGreaterThan(1200);      // 1위
  });

  it('기록 랭킹에 레이스 엔트리가 참가자별로 남는다 (R9)', async () => {
    const recs = (await api(h, host, '/api/records?bracket=race:normal')).body as { holders: unknown[] }[];
    expect(recs.length).toBe(3);                    // 완주자 세 명이 각각 한 줄
    expect(recs.every((r) => r.holders.length === 1)).toBe(true);
  });

  it('"다시 하기"를 누르면 룰은 남고 준비는 풀린다 (§1.3)', async () => {
    host.send({ t: 'room:rematch' });
    const st = await host.until('room:state', (m) => m.room.phase === 'waiting');
    expect(st.room.phase).toBe('waiting');
    expect(st.room.rules.difficulty).toBe('normal');
    expect(st.room.members.every((m) => !m.ready)).toBe(true);
  });
});
