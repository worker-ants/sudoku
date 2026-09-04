import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, signUp, sleep, startHarness, type Client, type Harness } from './harness.js';

/**
 * 문서에는 있는데 구현이 따라오지 않았던 것들 (2026-09-04 대조)
 *
 * 닉네임 변경(AUTH K2) · 재촉 알림(READY §5.1) · 칸 이력(COOP §7.2).
 * 덮어쓰기 확인(COOP §5)과 되돌리기(§7.3)는 클라이언트 쪽 장치라 여기서 다루지 않는다 —
 * 되돌리기는 별도 명령이 아니라 그 값을 다시 넣는 `cell:set` 이다.
 */
describe('스펙 대조에서 드러난 구멍들', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    for (let i = 0; i < 3; i++) await h.seedPuzzle('normal', 5150 + i * 31);
  }, 180000);
  afterAll(async () => { await h?.stop(); });

  describe('닉네임 변경 — 시즌당 1회 (AUTH K2)', () => {
    it('바꾸면 반영되고, 같은 시즌에 또 바꾸려 하면 거절한다', async () => {
      const c = await signUp(h, 'NickA');
      const r1 = await api(h, c, '/api/auth/nickname', 'POST', { nickname: '바뀐이름' });
      expect(r1.status).toBe(201);
      expect((await api(h, c, '/api/auth/me')).body).toMatchObject({ nickname: '바뀐이름' });

      const r2 = await api(h, c, '/api/auth/nickname', 'POST', { nickname: '또바꾼다' });
      expect(r2.status).toBeGreaterThanOrEqual(400);
      expect((r2.body as { message: string }).message).toContain('시즌당 한 번');
      c.close();
    });

    it('남이 쓰는 닉네임은 받지 않는다 (K2 유일성)', async () => {
      const a = await signUp(h, 'NickB'); const b = await signUp(h, 'NickC');
      const r = await api(h, a, '/api/auth/nickname', 'POST', { nickname: b.nickname });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect((r.body as { message: string }).message).toContain('이미 쓰이고');
      a.close(); b.close();
    });
  });

  describe('재촉 알림 (READY §5.1)', () => {
    it('호스트가 부르면 미준비자에게만 가고, 30초 안에 다시 부르면 막는다', async () => {
      const host = await signUp(h, 'NudgeH'); const guest = await signUp(h, 'NudgeG');
      const code = ((await api(h, host, '/api/rooms', 'POST', {})).body as { code: string }).code;
      await api(h, guest, '/api/rooms/join', 'POST', { code });
      await sleep(150);
      host.clear(); guest.clear();

      host.send({ t: 'ready:nudge' });
      const got = await guest.next('notice');
      expect(got.code).toBe('ready-nudge');
      expect(got.text).toContain(host.nickname);
      expect((await host.next('notice')).code).toBe('nudge-sent');

      host.send({ t: 'ready:nudge' });                       // 곧바로 다시
      expect((await host.next('notice')).code).toBe('nudge-cooldown');

      guest.send({ t: 'ready:nudge' });                      // 게스트는 못 부른다
      expect((await guest.next('notice')).code).toBe('not-host');
      host.close(); guest.close();
    }, 30000);
  });

  describe('칸 이력 (COOP §7.2)', () => {
    it('협동에서 넣은 값이 누가·언제로 남고, 정답 필드는 없다', async () => {
      const a = await signUp(h, 'HistA'); const b = await signUp(h, 'HistB');
      const code = ((await api(h, a, '/api/rooms', 'POST', {})).body as { code: string }).code;
      await api(h, b, '/api/rooms/join', 'POST', { code });
      a.send({ t: 'rules:update', patch: { mode: 'coop' } });
      await a.until('room:state', (m) => m.room.rules.mode === 'coop');
      b.send({ t: 'ready:toggle' });
      await a.until('room:state', (m) => m.room.members.some((x) => x.ready));
      a.clear();
      a.send({ t: 'match:start' });
      const started = (await a.next('match:started')).match;
      const blank = started.givens.findIndex((v) => !v);

      a.send({ t: 'cell:set', index: blank, value: 5 });
      await sleep(150);
      b.send({ t: 'cell:set', index: blank, value: 7 });
      await sleep(250);

      a.clear();
      a.send({ t: 'cell:history', index: blank });
      const hist = await a.next('cell:history');
      expect(hist.index).toBe(blank);
      expect(hist.entries.map((e) => e.value)).toEqual([5, 7]);
      expect(hist.entries.map((e) => e.accountId)).toEqual([a.accountId, b.accountId]);
      expect(hist.entries.every((e) => typeof e.atEpochMs === 'number')).toBe(true);
      // 정답을 담을 자리가 없다 (VISION 원칙 8 · 전송 가드와 같은 취지)
      expect(Object.keys(hist.entries[0]!).sort()).toEqual(['accountId', 'atEpochMs', 'value']);
      a.close(); b.close();
    }, 60000);
  });
});
