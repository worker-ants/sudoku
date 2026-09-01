import { describe, it, expect } from 'vitest';
import {
  adjustedFinishSec, compareForRank, gatePassed, judge, penaltyForNthWrongSubmit,
  rankPoint, requiredContribution, teamPoint, totalPenaltySec,
} from '../src/scoring/scoring.js';

const J = (o: Partial<Parameters<typeof judge>[0][number]> & { accountId: string }) => ({
  finished: false, adjustedFinishSec: null, correctCells: 0, wrongSubmits: 0, hintsUsed: 0, ...o,
});

describe('페널티와 조정 완주 시각 (D6 · D8)', () => {
  it('n번째 오답 제출에 +30n초 누진', () => {
    expect(penaltyForNthWrongSubmit(1)).toBe(30);
    expect(penaltyForNthWrongSubmit(2)).toBe(60);
    expect(penaltyForNthWrongSubmit(3)).toBe(90);
    expect(totalPenaltySec(3)).toBe(180);
    expect(totalPenaltySec(0)).toBe(0);
  });
  it('조정 완주 시각은 경과 초에 페널티를 더한 값이다', () => {
    // §7.2.1 의 수치 예: 1450초에 통과, 오답 3회 → 1630초
    expect(adjustedFinishSec(1450, 3)).toBe(1630);
  });
  it('조정 완주 시각은 제한 시간 밖으로 나갈 수 있다', () => {
    expect(adjustedFinishSec(1450, 3)).toBeGreaterThan(1500);
  });
});

describe('정렬 키 (§4.1)', () => {
  it('완주자가 미완주자보다 항상 앞', () => {
    expect(compareForRank(J({ accountId: 'a', finished: true, adjustedFinishSec: 9999 }), J({ accountId: 'b', correctCells: 80 }))).toBeLessThan(0);
  });
  it('완주자끼리는 조정 완주 시각이 빠른 쪽이 앞', () => {
    const a = J({ accountId: 'a', finished: true, adjustedFinishSec: 500 });
    const b = J({ accountId: 'b', finished: true, adjustedFinishSec: 400 });
    expect(compareForRank(a, b)).toBeGreaterThan(0);
  });
  it('미완주자끼리는 정답 칸 수가 많은 쪽이 앞', () => {
    expect(compareForRank(J({ accountId: 'a', correctCells: 30 }), J({ accountId: 'b', correctCells: 40 }))).toBeGreaterThan(0);
  });
  it('정답 칸 수가 같으면 오답 제출이 적은 쪽이 앞', () => {
    expect(compareForRank(J({ accountId: 'a', correctCells: 30, wrongSubmits: 2 }), J({ accountId: 'b', correctCells: 30, wrongSubmits: 0 }))).toBeGreaterThan(0);
  });
  it('그다음이 힌트 사용 횟수', () => {
    expect(compareForRank(J({ accountId: 'a', correctCells: 30, hintsUsed: 3 }), J({ accountId: 'b', correctCells: 30, hintsUsed: 0 }))).toBeGreaterThan(0);
  });
});

describe('순위와 rankPoint (§4.2)', () => {
  it('8인 방의 순위별 포인트가 표와 같다', () => {
    expect([1,2,3,4,5,6,7,8].map((r) => rankPoint(r, 8))).toEqual([100, 86, 71, 57, 43, 29, 14, 0]);
  });
  it('4인 방', () => expect([1,2,3,4].map((r) => rankPoint(r, 4))).toEqual([100, 67, 33, 0]));
  it('2인 방 1위도 100점이다 — 인원 가중치가 랭킹에서 보정한다', () => {
    expect(rankPoint(1, 2)).toBe(100);
  });
  it('공동 순위는 같은 순위를 주고 다음을 건너뛴다 (1,1,3)', () => {
    const r = judge([
      J({ accountId: 'a', finished: true, adjustedFinishSec: 100 }),
      J({ accountId: 'b', finished: true, adjustedFinishSec: 100 }),
      J({ accountId: 'c', finished: true, adjustedFinishSec: 200 }),
    ]);
    expect(r.map((x) => x.rank)).toEqual([1, 1, 3]);
  });
});

describe('팀 포인트 (§7.2 · D7)', () => {
  const limit = 1500, blanks = 54;
  it('페널티가 판 밖으로 밀어도 완주는 51 아래로 내려가지 않는다', () => {
    // §7.2.1 의 반례: 조정 1630초 → 이전 식이면 46
    const p = teamPoint({ finished: true, adjustedFinishSec: 1630, limitSec: limit, correctCells: 54, blankCells: blanks });
    expect(p).toBe(51);
  });
  it('그 판의 미완주 팀(53/54)은 49점이라 완주를 앞지르지 못한다', () => {
    const q = teamPoint({ finished: false, adjustedFinishSec: null, limitSec: limit, correctCells: 53, blankCells: blanks });
    expect(q).toBe(49);
    expect(q).toBeLessThan(51);
  });
  it('제출 없이 만료 시각에 완주 인정되면 경계에서 51이다', () => {
    expect(teamPoint({ finished: true, adjustedFinishSec: limit, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(51);
  });
  it('절반에 완주하면 75점', () => {
    expect(teamPoint({ finished: true, adjustedFinishSec: 750, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(75);
  });
  it('여유가 있으면 클램프가 물지 않고 원식이 그대로 나온다', () => {
    expect(teamPoint({ finished: true, adjustedFinishSec: 1000, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(67);
  });
  it('경계 직전에도 클램프가 문다 — 원식이 50으로 반올림되기 때문이다', () => {
    // §7.2.1 은 "조정 시각 ≥ 제한 시간일 때뿐"이라고 적었지만, 반올림 탓에 그 직전부터 문다.
    // 규정이 지키려는 것(완주 ≥ 51)은 그대로이고, 물리는 구간이 조금 더 넓을 뿐이다.
    expect(teamPoint({ finished: true, adjustedFinishSec: 1499, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(51);
    expect(teamPoint({ finished: true, adjustedFinishSec: 1486, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(51);
  });
});

describe('무임승차 게이트 (D3)', () => {
  it('§7.1 의 표와 같다', () => {
    expect(requiredContribution(54, 2)).toBe(9);
    expect(requiredContribution(54, 4)).toBe(5);
    expect(requiredContribution(30, 4)).toBe(5);
    expect(requiredContribution(54, 8)).toBe(5);
  });
  it('최소 5칸이 하한이다', () => expect(requiredContribution(0, 8)).toBe(5));
  it('미달자를 거른다', () => {
    expect(gatePassed(9, 54, 2)).toBe(true);
    expect(gatePassed(8, 54, 2)).toBe(false);
  });
});
