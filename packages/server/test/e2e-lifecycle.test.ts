import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, signUp, sleep, startHarness, type Client, type Harness } from './harness.js';

describe('룸 생명주기', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    // 판마다 퍼즐 하나를 소비한다 — 이 파일은 여러 판을 돌리므로 넉넉히 심는다
    for (let i = 0; i < 6; i++) await h.seedPuzzle('normal', 31415 + i * 7919);
  }, 180000);
  afterAll(async () => { await h?.stop(); });

  const setup = async (tag: string): Promise<{ a: Client; b: Client; code: string }> => {
    const a = await signUp(h, `${tag}A`); const b = await signUp(h, `${tag}B`);
    const code = ((await api(h, a, '/api/rooms', 'POST', {})).body as { code: string }).code;
    await api(h, b, '/api/rooms/join', 'POST', { code });
    return { a, b, code };
  };

  it('진행 중 멤버십이 0이 되면 판을 먼저 끝내고 결과를 확정한다 (§7.1)', async () => {
    const { a, b } = await setup('Emp');
    b.send({ t: 'ready:toggle' });
    await a.until('room:state', (m) => m.room.members.some((x) => x.ready));
    a.clear();
    a.send({ t: 'match:start' });
    const started = (await a.next('match:started')).match;

    a.send({ t: 'room:leave' });
    await sleep(150);
    b.send({ t: 'room:leave' });
    await sleep(400);

    expect(await h.db.hasMatchResult(started.matchId)).toBe(true);
    const rows = await h.db.listMatchResults(a.accountId, 5);
    expect(rows[0]!.endReason).toBe('membership-empty');
    const parts = rows[0]!.participants as { left: boolean }[];
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.left)).toBe(true);   // 이탈자도 결과에 포함된다
    a.close(); b.close();
  }, 60000);

  it('진행 중인 판이 있으면 다른 룸 참가가 거부된다 (L4)', async () => {
    const { a, b } = await setup('Blk');
    b.send({ t: 'ready:toggle' });
    await a.until('room:state', (m) => m.room.members.some((x) => x.ready));
    a.clear();
    a.send({ t: 'match:start' });
    await a.next('match:started');

    const other = await signUp(h, 'BlkC');
    const otherRoom = ((await api(h, other, '/api/rooms', 'POST', {})).body as { code: string }).code;
    const res = await api(h, a, '/api/rooms/join', 'POST', { code: otherRoom });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('in-match');
    a.close(); b.close(); other.close();
  }, 60000);

  it('호스트가 나가면 참가 순서가 가장 이른 사람에게 위임된다 (H1)', async () => {
    const { a, b } = await setup('Del');
    a.send({ t: 'room:leave' });
    const st = await b.until('room:state', (m) => m.room.members.length === 1);
    expect(st.room.members[0]!.isHost).toBe(true);
    expect(st.room.members[0]!.accountId).toBe(b.accountId);
    a.close(); b.close();
  }, 60000);

  it('강퇴당하면 룸 단위 차단 목록에 들어가 다시 못 들어온다 (H5)', async () => {
    const { a, b, code } = await setup('Kck');
    a.send({ t: 'room:kick', accountId: b.accountId });
    await b.next('room:closed');
    const res = await api(h, b, '/api/rooms/join', 'POST', { code });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('banned');
    a.close(); b.close();
  }, 60000);

  it('랭크 레이스 판은 진행 중 채팅이 닫힌다 (C1)', async () => {
    const a = await signUp(h, 'ChA'); const b = await signUp(h, 'ChB'); const c = await signUp(h, 'ChC');
    const code = ((await api(h, a, '/api/rooms', 'POST', {})).body as { code: string }).code;
    await api(h, b, '/api/rooms/join', 'POST', { code });
    await api(h, c, '/api/rooms/join', 'POST', { code });
    a.send({ t: 'chat:send', text: '대기 중에는 열려 있다' });
    expect((await b.next('chat')).message.text).toBe('대기 중에는 열려 있다');
    for (const x of [b, c]) x.send({ t: 'ready:toggle' });
    await a.until('room:state', (m) => m.room.members.filter((x) => x.ready).length === 2);
    a.clear();
    a.send({ t: 'match:start' });
    await a.next('match:started');
    a.send({ t: 'chat:send', text: '3행 7열 8이야' });
    const n = await a.next('notice');
    expect(n.code).toBe('chat-closed');
    a.close(); b.close(); c.close();
  }, 60000);

  it('채팅은 토큰 버킷 — 버스트 5건 뒤에는 막힌다 (C4)', async () => {
    const { a, b } = await setup('Rat');
    for (let i = 0; i < 5; i++) a.send({ t: 'chat:send', text: `연타 ${i}` });
    await sleep(200);
    expect(b.drain('chat')).toHaveLength(5);
    a.send({ t: 'chat:send', text: '여섯 번째' });
    const n = await a.next('notice');
    expect(n.code).toBe('chat-rate');
    a.close(); b.close();
  }, 60000);
});
