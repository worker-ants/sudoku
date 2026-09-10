import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, signUp, sleep, startHarness, type Client, type Harness } from './harness.js';

/**
 * 노드 둘 (단일 프로세스 제약의 해소)
 *
 * 서버가 하나였을 때 이 프로젝트는 세 곳에서 프로세스에 묶여 있었다.
 *   ① 나가는 메시지가 **자기 소켓에만** 나갔다
 *   ② 진행 중인 판의 상태와 타이머가 **그 프로세스 메모리에만** 있었다
 *   ③ 룸의 읽고-고쳐-쓰기 잠금이 **프로세스 안 Map** 이었다
 *
 * 이 파일은 셋이 실제로 풀렸는지 본다. 노드 둘을 띄우고 **한 룸의 두 사람을 서로 다른
 * 노드에 붙인 채** 판을 굴린다 — 하나라도 남아 있으면 상대의 화면이 멈춘다.
 *
 * 두 노드는 상태 저장소·버스·영구 저장소를 공유한다. 운영에서 파드들이 Redis 와
 * Postgres 를 나눠 보는 것과 같은 모양이고, 여기서는 한 프로세스 안의 객체가 그 자리를
 * 대신한다. **노드를 건너는 코드는 그것이 무엇이든 같은 길을 지난다.**
 */
describe('노드 둘', () => {
  let a: Harness;   // 호스트가 붙는 노드
  let b: Harness;   // 손님이 붙는 노드
  let host: Client;
  let guest: Client;
  let puzzle: { givens: number[]; solution: number[]; puzzleId: string };
  let code = '';

  beforeAll(async () => {
    a = await startHarness();
    b = await startHarness(undefined, { state: a.state, bus: a.bus, db: a.db });
    puzzle = await a.seedPuzzle('normal');
    await a.seedPuzzle('normal', 24680);

    host = await signUp(a, 'NodeHost');
    guest = await signUp(a, 'NodeGuest', { socketOn: b });   // 가입은 A, 소켓은 B
  }, 180000);

  afterAll(async () => {
    host?.close(); guest?.close();
    await b?.stop();   // 빌려 쓴 노드부터 접는다
    await a?.stop();
  });

  it('두 노드가 같은 룸을 본다 — 참가가 상대 노드의 소켓에 닿는다', async () => {
    const r = await api(a, host, '/api/rooms', 'POST', { name: '두 노드 방' });
    code = (r.body as { code: string }).code;

    host.clear();
    const j = await api(b, guest, '/api/rooms/join', 'POST', { code });
    expect(j.status).toBe(201);

    // ①의 증거 — A 노드에 붙은 호스트가, B 노드에서 일어난 참가를 본다
    const seen = await host.until('room:state', (m) => m.room.members.length === 2);
    expect(seen.room.members.map((x) => x.nickname).sort()).toEqual(['NodeGuest', 'NodeHost']);
  }, 30000);

  it('채팅이 노드를 건넌다', async () => {
    guest.clear();
    host.send({ t: 'chat:send', text: '건너오나' });
    const msg = await guest.until('chat', (m) => m.message.kind === 'user');
    expect(msg.message.text).toBe('건너오나');
    expect(msg.message.nickname).toBe('NodeHost');
  }, 30000);

  it('판 시작이 양쪽 노드에 닿는다', async () => {
    guest.send({ t: 'ready:toggle' });
    await host.until('room:state', (m) => m.room.members.every((x) => x.isHost || x.ready));

    host.clear(); guest.clear();
    host.send({ t: 'match:start' });

    const onA = (await host.next('match:started', 20000)).match;
    const onB = (await guest.next('match:started', 20000)).match;
    expect(onB.matchId).toBe(onA.matchId);
    expect(onB.givens).toEqual(puzzle.givens);

    // 판은 A 가 갖는다 — 시작을 처리한 노드다. B 는 갖고 있지 않다.
    expect(a.matches.get(onA.matchId)).not.toBeNull();
    expect(b.matches.get(onA.matchId)).toBeNull();
  }, 40000);

  it('②의 증거 — 판을 갖지 않은 노드의 입력이 가진 노드로 건너간다', async () => {
    const blanks = puzzle.givens.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
    const target = blanks[0]!;

    // B 노드에 붙은 손님이 칸을 채운다. 판은 A 에 있다.
    guest.send({ t: 'cell:set', index: target, value: puzzle.solution[target]! });

    // A 가 가진 상태가 실제로 바뀌었는지 본다 — 중계된 화면이 아니라 진짜 판이다
    const matchId = a.matches.matchOfRoom((await a.rooms.membershipOf(host.accountId))!.roomId)!.matchId;
    for (let i = 0; i < 100; i++) {
      const m = a.matches.get(matchId)!;
      if (m.participants.get(guest.accountId)!.cells[target] === puzzle.solution[target]) break;
      await sleep(20);
    }
    const applied = a.matches.get(matchId)!.participants.get(guest.accountId)!.cells[target];
    expect(applied).toBe(puzzle.solution[target]);
  }, 30000);

  it('진행 상황이 판을 갖지 않은 노드의 소켓에도 흐른다', async () => {
    guest.clear();
    const p = await guest.until('progress', (m) => m.progress.kind === 'race', 15000);
    expect(p.progress.kind).toBe('race');
    if (p.progress.kind === 'race') {
      const mine = p.progress.participants.find((x) => x.accountId === guest.accountId)!;
      expect(mine.filled).toBeGreaterThan(0);   // 방금 채운 칸이 세어졌다
    }
  }, 30000);

  it('판을 갖지 않은 노드에서 제출해도 결과가 그 사람에게 돌아온다', async () => {
    // 아직 빈칸이 남았으므로 막혀야 한다 — 중요한 것은 **회신이 온다**는 사실이다.
    guest.clear();
    guest.send({ t: 'submit:request' });
    const notice = await guest.next('notice', 15000);
    expect(notice.code).toBe('incomplete');
  }, 30000);

  it('판이 끝나면 양쪽 노드가 같은 결과를 받는다', async () => {
    const blanks = puzzle.givens.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
    for (const c of [host, guest]) {
      for (const i of blanks) c.send({ t: 'cell:set', index: i, value: puzzle.solution[i]! });
    }
    await sleep(500);
    host.clear(); guest.clear();
    host.send({ t: 'submit:request' });
    guest.send({ t: 'submit:request' });

    const endedA = await host.next('match:ended', 20000);
    const endedB = await guest.next('match:ended', 20000);
    expect(endedB.result.matchId).toBe(endedA.result.matchId);
    expect(endedA.result.endReason).toBe('all-finished');
    // 정답 공개는 확정된 뒤의 것이다 — 중계를 타고도 그 순서가 지켜졌다
    expect(endedB.result.solutionRevealed).toEqual(puzzle.solution);
  }, 60000);

  it('③의 증거 — 룸 잠금이 노드를 건너 걸린다', async () => {
    // 같은 룸을 두 노드에서 동시에 두드린다. 잠금이 프로세스 안에만 있으면
    // 둘이 같은 스냅샷을 읽어 한쪽 수정이 사라진다.
    const room = (await a.rooms.membershipOf(host.accountId))!;
    const before = room.ruleState.rules.limitSec;

    await Promise.all([
      a.rooms.withLock(async () => {
        const r = (await a.rooms.get(room.roomId))!;
        r.name = `${r.name}·A`;
        await sleep(30);                     // 잠금 없이라면 B 가 끼어들 틈
        await a.rooms.save(r);
      }),
      b.rooms.withLock(async () => {
        const r = (await b.rooms.get(room.roomId))!;
        r.isPublic = false;
        await sleep(30);
        await b.rooms.save(r);
      }),
    ]);

    const after = (await a.rooms.get(room.roomId))!;
    expect(after.name.endsWith('·A')).toBe(true);   // A 의 수정이 남았고
    expect(after.isPublic).toBe(false);             // B 의 수정도 남았다 — 서로 덮지 않았다
    expect(after.ruleState.rules.limitSec).toBe(before);
  }, 30000);

  it('같은 계정이 다른 노드에 접속하면 옛 연결이 끊긴다', async () => {
    const second = await signUp(a, 'Twice');
    const replaced = new Promise<string>((resolve) => {
      second.socket.on('msg', (m: { t: string; code?: string }) => {
        if (m.t === 'notice' && m.code === 'replaced') resolve(m.code);
      });
    });
    // 같은 쿠키로 B 노드에 다시 붙는다
    const { io } = await import('socket.io-client');
    const other = io(b.url, { transports: ['websocket'], extraHeaders: { cookie: second.cookie }, forceNew: true });
    await new Promise<void>((res, rej) => { other.once('connect', () => res()); other.once('connect_error', rej); });

    expect(await Promise.race([replaced, sleep(8000).then(() => 'timeout')])).toBe('replaced');
    other.close(); second.close();
  }, 30000);
});

/**
 * 노드가 죽으면 남은 노드가 판을 주워 온다.
 *
 * 소유권은 수명이 달린 키다. 가진 노드가 멎으면 그 키가 풀리고, 살아 있는 노드가
 * 주기적으로 훑다가 집어 간다(main.ts 의 인수 루프). 여기서는 그 루프를 손으로 돌린다 —
 * 시험이 15초를 기다릴 이유가 없다.
 */
describe('노드가 빠져도 판은 이어진다', () => {
  let a: Harness;
  let b: Harness;
  let solo: Client;
  let puzzle: { givens: number[]; solution: number[]; puzzleId: string };

  beforeAll(async () => {
    a = await startHarness();
    b = await startHarness(undefined, { state: a.state, bus: a.bus, db: a.db });
    puzzle = await a.seedPuzzle('normal');
    solo = await signUp(a, 'Orphan');
  }, 180000);

  afterAll(async () => { solo?.close(); await b?.stop(); await a?.stop(); });

  it('A 가 든 판을, A 가 손을 뗀 뒤 B 가 인수한다', async () => {
    await api(a, solo, '/api/rooms', 'POST', { name: '인수 방' });
    solo.clear();
    solo.send({ t: 'match:start' });
    const started = (await solo.next('match:started', 20000)).match;

    expect(a.matches.get(started.matchId)).not.toBeNull();
    expect(b.matches.get(started.matchId)).toBeNull();

    // A 가 죽는 시늉 — 소유권까지 놓는다(정상 종료가 하는 일)
    await a.matches.shutdown();
    expect(a.matches.get(started.matchId)).toBeNull();

    // B 의 인수 루프가 한 바퀴 돈다
    const picked = await b.matches.adoptOrphans();
    expect(picked.resumed).toContain(started.matchId);

    // 이제 판은 B 의 것이고, 상태가 온전히 살아 있다.
    // 단서는 **시작할 때 클라이언트가 받은 것과** 대조한다 — 풀이 그때그때 퍼즐을
    // 뽑으므로 시드해 둔 것과 같다는 보장이 없고, 여기서 볼 것은 "인수하며 잃은 것이
    // 없는가" 이지 어떤 퍼즐이 뽑혔는가가 아니다.
    const m = b.matches.get(started.matchId)!;
    expect(m.matchId).toBe(started.matchId);
    expect(m.participants.has(solo.accountId)).toBe(true);
    expect([...m.givens]).toEqual(started.givens);
  }, 60000);

  it('인수한 노드가 판을 끝까지 굴린다', async () => {
    const room = (await b.rooms.membershipOf(solo.accountId))!;
    const m = b.matches.matchOfRoom(room.roomId)!;
    // 인수한 판이 들고 있는 정답으로 채운다 — 어떤 퍼즐이 뽑혔든 이 판의 것이다
    const solution = [...m.solution];
    const blanks = [...m.givens].map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);

    solo.clear();
    for (const i of blanks) solo.send({ t: 'cell:set', index: i, value: solution[i]! });
    await sleep(400);
    solo.send({ t: 'submit:request' });

    const ended = await solo.next('match:ended', 30000);
    expect(ended.result.matchId).toBe(m.matchId);
    expect(ended.result.endReason).toBe('all-finished');
    expect(await b.db.hasMatchResult(m.matchId)).toBe(true);
  }, 60000);
});
