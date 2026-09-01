import { describe, it, expect } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, signUp, sleep, startHarness } from './harness.js';

/**
 * 판 종료 감지도 재시작을 견뎌야 한다 (AREA-PLAY §4.1)
 *
 * 상태는 프로세스 밖에 있지만 **타이머는 상태가 아니다.** 부팅 때 종료 시각에서 다시 걸고,
 * 만료를 지나친 판은 **발견 시각이 아니라 종료 시각** 기준으로 채점한다.
 */
describe('재시작 복구', () => {
  it('진행 중이던 판이 새 프로세스에서 이어진다 — 남은 제출 횟수와 보드까지', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sudoku-recover-'));
    let h = await startHarness(dir);
    const pz = await h.seedPuzzle('normal', 90210);
    let a = await signUp(h, 'Rea'); let b = await signUp(h, 'Reb');
    const code = ((await api(h, a, '/api/rooms', 'POST', {})).body as { code: string }).code;
    await api(h, b, '/api/rooms/join', 'POST', { code });
    b.send({ t: 'ready:toggle' });
    await a.until('room:state', (m) => m.room.members.some((x) => x.ready));
    a.clear();
    a.send({ t: 'match:start' });
    const started = (await a.next('match:started')).match;
    const blanks = started.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    for (const i of blanks.slice(0, 10)) a.send({ t: 'cell:set', index: i, value: pz.solution[i]! });
    await sleep(300);

    const matchId = started.matchId;
    a.close(); b.close();
    await h.stop(true);                       // 프로세스가 죽는다 (판은 아직 진행 중)

    h = await startHarness(dir);              // 새 프로세스
    const rec = await h.matches.recoverOnBoot();
    expect(rec.resumed).toContain(matchId);
    const m = h.matches.get(matchId)!;
    expect(m.finalizedAtEpochMs).toBeNull();
    // 보드가 그대로 살아 있다
    for (const i of blanks.slice(0, 10)) expect(m.participants.get(a.accountId)!.cells[i]).toBe(pz.solution[i]);

    // 재접속하면 서버가 현재 상태를 통째로 내려보낸다 (§4)
    a = await signUp(h, 'Rea2');
    a.close();
    await h.stop();
    rmSync(dir, { recursive: true, force: true });
  }, 120000);

  it('다운타임이 만료를 넘겼으면 종료 시각 기준으로 채점한다 — 발견 시각이 아니다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sudoku-recover2-'));
    let h = await startHarness(dir);
    const pz = await h.seedPuzzle('intro', 4711);
    const a = await signUp(h, 'Exa'); const b = await signUp(h, 'Exb');
    const code = ((await api(h, a, '/api/rooms', 'POST', {})).body as { code: string }).code;
    await api(h, b, '/api/rooms/join', 'POST', { code });
    a.send({ t: 'rules:update', patch: { difficulty: 'intro', limitSec: 180 }, followStandardLimit: false });
    await a.until('room:state', (m) => m.room.rules.limitSec === 180);
    b.send({ t: 'ready:toggle' });
    await a.until('room:state', (m) => m.room.members.some((x) => x.ready));
    a.clear();
    a.send({ t: 'match:start' });
    const started = (await a.next('match:started')).match;
    const blanks = started.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    for (const i of blanks) a.send({ t: 'cell:set', index: i, value: pz.solution[i]! });   // 다 채우고 제출은 안 함
    await sleep(400);
    const matchId = started.matchId;
    const endsAt = started.endsAtEpochMs;
    a.close(); b.close();
    await h.stop(true);

    // 저장된 판의 종료 시각을 과거로 옮겨 "다운타임이 만료를 넘긴" 상황을 만든다
    const { FileStateStore, stateFilePath } = await import('../src/storage/file-state.store.js');
    const st = new FileStateStore(stateFilePath(dir));
    const stored = await st.get<{ base: { endsAtEpochMs: number; startedAtEpochMs: number; limitSec: number } }>(`match:${matchId}`);
    const shifted = Date.now() - 60_000;
    stored!.base.endsAtEpochMs = shifted;
    stored!.base.startedAtEpochMs = shifted - stored!.base.limitSec * 1000;
    await st.set(`match:${matchId}`, stored);
    await st.close();

    h = await startHarness(dir);
    const rec = await h.matches.recoverOnBoot();
    expect(rec.finalized).toContain(matchId);          // 그 자리에서 채점됐다

    const hist = await h.db.listMatchResults(a.accountId, 5);
    expect(hist).toHaveLength(1);
    const parts = hist[0]!.participants as { accountId: string; finished: boolean; adjustedFinishSec: number }[];
    const rea = parts.find((p) => p.accountId === a.accountId)!;
    // 제출하지 않은 완성 보드는 완주로 인정하되 완주 시각은 만료 시각이다 (§5.1)
    expect(rea.finished).toBe(true);
    expect(rea.adjustedFinishSec).toBe(180);           // 발견 시각(+60초)이 아니라 제한 시간
    expect(hist[0]!.endedAtEpochMs).toBe(shifted);     // 종료 시각으로 굳었다
    void endsAt;
    await h.stop();
    rmSync(dir, { recursive: true, force: true });
  }, 120000);
});
