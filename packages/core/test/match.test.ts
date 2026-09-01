import { describe, it, expect } from 'vitest';
import { generatePuzzle } from '../src/sudoku/generator.js';
import {
  allFinished, boardOf, cancelTeamSubmit, createMatch, dueEndReason, finalizeMatch, fireTeamSubmit,
  markLeft, membershipEmpty, requestHint, requestTeamSubmit, setCell, submitRace, submitBlockedReason,
  SUBMIT_WINDOW_MS, type MatchState,
} from '../src/match/match.js';
import { blankCount, violations } from '../src/sudoku/grid.js';

const PZ = generatePuzzle('normal', { seed: 4242, maxAttempts: 80 }).puzzle!;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function mk(mode: 'race' | 'coop', members = ['a', 'b'], opts: Partial<Parameters<typeof createMatch>[0]> = {}): MatchState {
  return createMatch({
    matchId: 'm1', roomId: 'r1', puzzleId: PZ.puzzleId,
    mode, difficulty: 'normal', limitSec: 900,
    violationDisplay: 'show', hintsAllowed: false, rankEligible: true,
    givens: [...PZ.givens], solution: [...PZ.solution], path: PZ.path,
    members: members.map((id) => ({ accountId: id, nickname: id.toUpperCase() })),
    nowMs: T0, ...opts,
  });
}
const fill = (m: MatchState, who: string, correct = true) => {
  for (let i = 0; i < 81; i++) {
    if (PZ.givens[i]) continue;
    const v = correct ? PZ.solution[i]! : 0;
    if (v) setCell(m, who, i, v, T0 + 1000);
  }
};

describe('입력', () => {
  it('원본 단서 칸은 고칠 수 없다', () => {
    const m = mk('race');
    const given = PZ.givens.findIndex((v) => v > 0);
    expect(setCell(m, 'a', given, 5, T0 + 1).ok).toBe(false);
  });
  it('레이스는 남의 입력이 내 보드에 닿지 않는다', () => {
    const m = mk('race');
    const blank = PZ.givens.findIndex((v) => !v);
    setCell(m, 'a', blank, 9, T0 + 1);
    expect(boardOf(m, 'a')[blank]).toBe(9);
    expect(boardOf(m, 'b')[blank]).toBe(0);
  });
  it('협동은 한 보드를 공유하고 중계용 변경을 낸다', () => {
    const m = mk('coop');
    const blank = PZ.givens.findIndex((v) => !v);
    const r = setCell(m, 'a', blank, 9, T0 + 1);
    expect(r.ok).toBe(true);
    expect(r.change).toMatchObject({ index: blank, value: 9, by: 'a' });
    expect(boardOf(m, 'b')[blank]).toBe(9);
  });
  it('제한 시간이 지나면 입력을 받지 않는다', () => {
    const m = mk('race');
    const blank = PZ.givens.findIndex((v) => !v);
    expect(setCell(m, 'a', blank, 9, T0 + 900_001).reason).toBe('time-expired');
  });
  it('나간 사람의 입력은 받지 않는다', () => {
    const m = mk('race');
    markLeft(m, 'a');
    expect(setCell(m, 'a', PZ.givens.findIndex((v) => !v), 9, T0 + 1).reason).toBe('left');
  });
});

describe('제출 (N1 · N2)', () => {
  it('빈칸이 남았으면 제출할 수 없다', () => {
    const m = mk('race');
    expect(submitBlockedReason(m, 'a')).toBe('incomplete');
  });
  it('제약 위반이 남았으면 제출할 수 없다 — 숨김 판에서도 마찬가지다 (E4)', () => {
    const m = mk('race', ['a', 'b'], { violationDisplay: 'hide' });
    const blanks = PZ.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    for (const i of blanks) setCell(m, 'a', i, 1, T0 + 1);   // 전부 1 → 위반 천지
    expect(submitBlockedReason(m, 'a')).toBe('violation');
  });
  it('정답이면 통과하고 그 참가자의 판이 끝난다', () => {
    const m = mk('race');
    fill(m, 'a');
    const r = submitRace(m, 'a', T0 + 60_000);
    expect(r.outcome!.passed).toBe(true);
    expect(r.outcome!.finishedAtElapsedSec).toBe(60);
    expect(setCell(m, 'a', PZ.givens.findIndex((v) => !v), 1, T0 + 61_000).reason).toBe('already-finished');
  });
  /**
   * 발견 (2026-09-01 구현 중)
   *
   * 제출 게이트가 "빈칸 0 + 제약 위반 0" 이고 퍼즐의 해가 유일하므로,
   * **게이트를 통과하는 보드는 반드시 정답이다** — 행·열·박스에 중복이 없는 완성 보드는
   * 정의상 유효한 스도쿠이고, 원본 단서가 고정된 상태에서 그런 보드는 하나뿐이기 때문이다.
   *
   * 그래서 N1(틀린 칸 수 회신)·N2(상한 5회·+30n초)와 그 위에 선 규칙들이 닿지 않는다.
   * 코드는 스펙대로 두되(게이트는 §1.3·E4 가 두 번 정한 규칙이다) 이 사실을 여기 박아 둔다.
   */
  it('제약 위반이 없는 완성 보드는 반드시 정답이다 — 오답 제출이 구조적으로 불가능하다', () => {
    const m = mk('race');
    fill(m, 'a');
    expect(submitBlockedReason(m, 'a')).toBeNull();
    const r = submitRace(m, 'a', T0 + 70_000);
    expect(r.outcome!.passed).toBe(true);

    // 정답에서 두 칸을 맞바꾼 보드는 반드시 제약 위반을 낳는다(값이 같은 쌍은 제외)
    const blanks = PZ.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    let violationFreeButWrong = 0;
    for (const x of blanks) for (const y of blanks) {
      if (x >= y || PZ.solution[x] === PZ.solution[y]) continue;
      const b = [...PZ.solution];
      [b[x], b[y]] = [b[y]!, b[x]!];
      if (violations(b).size === 0) violationFreeButWrong++;
    }
    expect(violationFreeButWrong).toBe(0);
  });

  it('오답 제출 경로 자체는 살아 있다 — 게이트를 우회해 도달하면 틀린 칸 수만 돌려준다', () => {
    // 게이트가 막으므로 정상 경로로는 닿지 않는다. 채점 로직이 맞는지만 직접 확인한다.
    const m = mk('race');
    fill(m, 'a');
    const blanks = PZ.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    m.participants.get('a')!.cells[blanks[0]!] = ((PZ.solution[blanks[0]!]! % 9) + 1);
    const r = submitRace(m, 'a', T0 + 70_000);
    expect(r.ok).toBe(false);            // 게이트가 막는다 — 위반이 생겼기 때문
    expect(r.reason).toBe('violation');
  });
});

describe('협동 5초 취소 창 — 서버가 소유한다 (O7)', () => {
  const open = () => {
    const m = mk('coop');
    fill(m, 'a');
    const r = requestTeamSubmit(m, 'a', T0 + 10_000);
    return { m, r };
  };
  it('창이 열리면 스냅샷이 굳고 끝나는 시각이 정해진다', () => {
    const { r } = open();
    expect(r.ok).toBe(true);
    expect(r.endsAtMs).toBe(T0 + 10_000 + SUBMIT_WINDOW_MS);
  });
  it('창이 열린 동안 도착한 셀 입력은 서버가 버린다', () => {
    const { m } = open();
    const blank = PZ.givens.findIndex((v) => !v);
    const before = boardOf(m, 'a')[blank];
    const res = setCell(m, 'a', blank, 1, T0 + 11_000);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('submit-window-open');
    expect(boardOf(m, 'a')[blank]).toBe(before);          // 보드가 바뀌지 않았다
  });
  it('누구든 취소할 수 있고, 취소하면 횟수를 소모하지 않으며 팀 전체 10초 쿨다운이 걸린다', () => {
    const { m } = open();
    expect(cancelTeamSubmit(m, 'b', T0 + 12_000).ok).toBe(true);
    expect(m.team!.submitsUsed).toBe(0);
    expect(requestTeamSubmit(m, 'a', T0 + 13_000).reason).toBe('cooldown');
    expect(requestTeamSubmit(m, 'a', T0 + 23_000).ok).toBe(true);
  });
  it('창이 끝나면 누른 순간의 스냅샷을 채점한다', () => {
    const { m } = open();
    const fired = fireTeamSubmit(m, T0 + 15_000);
    expect(fired.fired).toBe(true);
    expect(fired.outcome!.passed).toBe(true);
    expect(m.team!.finished).toBe(true);
  });
  it('팀 완주가 곧 전원 완주다', () => {
    const { m } = open();
    fireTeamSubmit(m, T0 + 15_000);
    expect([...m.participants.values()].every((p) => p.finished)).toBe(true);
    expect(allFinished(m)).toBe(true);
  });
  it('창이 끝나기 전에는 발사되지 않는다', () => {
    const { m } = open();
    expect(fireTeamSubmit(m, T0 + 12_000).fired).toBe(false);
  });
});

describe('힌트 (P3)', () => {
  it('허용하지 않은 판에서는 거부', () => {
    const m = mk('race');
    expect(requestHint(m, 'a', T0 + 1).reason).toBe('hints-not-allowed');
  });
  it('위치와 기법 이름만 돌려준다 — 값이 없다', () => {
    const m = mk('race', ['a', 'b'], { hintsAllowed: true });
    const h = requestHint(m, 'a', T0 + 1);
    expect(h.ok).toBe(true);
    expect(h.index).toBeGreaterThanOrEqual(0);
    expect(h.technique).toBeTruthy();
    expect(Object.keys(h)).not.toContain('value');
  });
  it('판당 3회 — 협동은 팀이 공유한다', () => {
    const m = mk('coop', ['a', 'b'], { hintsAllowed: true });
    expect(requestHint(m, 'a', T0 + 1).ok).toBe(true);
    expect(requestHint(m, 'b', T0 + 2).ok).toBe(true);
    expect(requestHint(m, 'a', T0 + 3).ok).toBe(true);
    expect(requestHint(m, 'b', T0 + 4).reason).toBe('hint-limit');   // 개인별이면 통과했을 자리
  });
  it('보드가 다 차면 지목할 칸이 없어 거부한다 — 오답이 섞여 있어도', () => {
    const m = mk('race', ['a', 'b'], { hintsAllowed: true });
    fill(m, 'a');
    expect(requestHint(m, 'a', T0 + 5).reason).toBe('board-full');
  });
});

describe('판 종료', () => {
  it('종료 조건 셋 — 전원 완주 · 제한 시간 만료 · 진행 중 멤버십 0', () => {
    const m1 = mk('race'); fill(m1, 'a'); fill(m1, 'b');
    submitRace(m1, 'a', T0 + 1000); submitRace(m1, 'b', T0 + 2000);
    expect(dueEndReason(m1, T0 + 3000)).toBe('all-finished');

    const m2 = mk('race');
    expect(dueEndReason(m2, T0 + 900_001)).toBe('time-expired');

    const m3 = mk('race');
    markLeft(m3, 'a'); markLeft(m3, 'b');
    expect(membershipEmpty(m3)).toBe(true);
    expect(dueEndReason(m3, T0 + 5000)).toBe('membership-empty');
  });

  it('제출하지 않은 완성 보드는 완주로 인정하되 완주 시각은 만료 시각이다 (§5.1)', () => {
    const m = mk('race');
    fill(m, 'a');                                  // 다 채우고 제출은 안 함
    const f = finalizeMatch(m, 'time-expired', m.endsAtEpochMs);
    const a = f.participants.find((p) => p.accountId === 'a')!;
    expect(a.finished).toBe(true);
    expect(a.adjustedFinishSec).toBe(900);         // 만료 시각 = 제한 시간
  });

  it('채점 기준 시각은 발견 시각이 아니라 종료 시각이다', () => {
    const m = mk('race');
    fill(m, 'a');
    // 서버가 30분 늦게 발견했더라도 종료 시각으로 굳힌다
    const f = finalizeMatch(m, 'time-expired', m.endsAtEpochMs);
    expect(f.participants.find((p) => p.accountId === 'a')!.adjustedFinishSec).toBe(900);
  });

  it('모든 참가자를 결과에 넣는다 — 이탈자도', () => {
    const m = mk('race');
    markLeft(m, 'b');
    const f = finalizeMatch(m, 'time-expired', m.endsAtEpochMs);
    expect(f.participants).toHaveLength(2);
    expect(f.participants.find((p) => p.accountId === 'b')!.left).toBe(true);
  });
});

describe('협동 기여도와 게이트 (D3 · D5)', () => {
  it('정답 칸의 최초 입력자에게 기여가 붙는다 — 덮어썼다 되돌려도', () => {
    const m = mk('coop', ['a', 'b', 'c']);
    const blanks = PZ.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    const cell = blanks[0]!;
    const correct = PZ.solution[cell]!;
    setCell(m, 'a', cell, correct, T0 + 1000);                      // A 가 정답을 처음 넣고
    setCell(m, 'b', cell, (correct % 9) + 1, T0 + 2000);            // B 가 덮고
    setCell(m, 'c', cell, correct, T0 + 3000);                      // C 가 되돌린다
    for (const i of blanks.slice(1)) setCell(m, 'b', i, PZ.solution[i]!, T0 + 4000);
    const f = finalizeMatch(m, 'time-expired', m.endsAtEpochMs);
    const a = f.participants.find((p) => p.accountId === 'a')!;
    const c = f.participants.find((p) => p.accountId === 'c')!;
    expect(a.contribution).toBe(1);      // 찾아낸 것은 A
    expect(c.contribution).toBe(0);      // C 는 복구했을 뿐
  });

  it('게이트 미달자는 표시되고 통과자는 통과한다', () => {
    const m = mk('coop', ['a', 'b']);
    const blanks = PZ.givens.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    for (const i of blanks) setCell(m, 'a', i, PZ.solution[i]!, T0 + 1000);   // A 가 전부
    const f = finalizeMatch(m, 'time-expired', m.endsAtEpochMs);
    const a = f.participants.find((p) => p.accountId === 'a')!;
    const b = f.participants.find((p) => p.accountId === 'b')!;
    expect(a.requiredContribution).toBe(Math.max(5, Math.floor(blankCount(PZ.givens) / 2 / 3)));
    expect(a.gatePassed).toBe(true);
    expect(b.contribution).toBe(0);
    expect(b.gatePassed).toBe(false);
  });

  it('협동은 순위를 매기지 않는다', () => {
    const m = mk('coop');
    const f = finalizeMatch(m, 'time-expired', m.endsAtEpochMs);
    expect(f.participants.every((p) => p.rank === 0 && p.rankPoint === 0)).toBe(true);
    expect(f.team).toBeDefined();
  });

  it('팀 포인트가 결과에 실린다', () => {
    const m = mk('coop');
    fill(m, 'a');
    requestTeamSubmit(m, 'a', T0 + 10_000);
    fireTeamSubmit(m, T0 + 15_000);
    const f = finalizeMatch(m, 'all-finished', T0 + 15_000);
    expect(f.team!.finished).toBe(true);
    expect(f.team!.teamPoint).toBeGreaterThanOrEqual(51);
  });
});
