import { describe, it, expect } from 'vitest';
import {
  adjustedFinishSec, compareForRank, gatePassed, judge,
  rankPoint, requiredContribution, teamPoint,
} from '../src/scoring/scoring.js';

const J = (o: Partial<Parameters<typeof judge>[0][number]> & { accountId: string }) => ({
  finished: false, adjustedFinishSec: null, correctCells: 0, hintsUsed: 0, ...o,
});

describe('조정 완주 시각 (D8 · D10)', () => {
  it('조정분이 없다 — 통과 시각의 경과 초 그대로다', () => {
    expect(adjustedFinishSec(1450)).toBe(1450);
    expect(adjustedFinishSec(0)).toBe(0);
  });
  it('제한 시간 밖으로 나갈 수 없다 — 페널티가 폐기됐다(D10)', () => {
    expect(adjustedFinishSec(1450)).toBeLessThanOrEqual(1500);
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
  it('정답 칸 수가 같으면 그다음은 힌트 사용 횟수다 — 4번 키는 폐기됐다(D10)', () => {
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
  it('§5.1 의 예외로 만료 시각에 완주로 인정되면 식이 50이라 하한 51이 물린다', () => {
    // D10 이후 조정 완주 시각이 제한 시간을 넘을 수 없다. 하한이 물리는 경우는 이 예외와
    // 제한 시간의 마지막 1% 둘이다(§7.2.1). 마지막 1% 는 아래 경계 시험에서 본다.
    expect(teamPoint({ finished: true, adjustedFinishSec: limit, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(51);
  });
  it('미완주 최고점(53/54)은 49점이라 그 완주를 앞지르지 못한다', () => {
    const q = teamPoint({ finished: false, adjustedFinishSec: null, limitSec: limit, correctCells: 53, blankCells: blanks });
    expect(q).toBe(49);
    expect(q).toBeLessThan(51);
  });
  it('하한은 식이 51 미만을 내는 지점부터 물린다. 제한 시간보다 조금 앞이다', () => {
    // §7.2.1 의 경계표: 1470초는 식이 그대로 51이다. 1485초는 50 × 15/1500 = 0.5 를 올려
    // 식이 그대로 51이고 하한은 물리지 않는다. 하한은 1486초부터 물린다.
    // 1470 · 1485 · 1486초 모두 결과가 51이라 결과만으로는 식과 하한을 가를 수 없다. 반올림 방식은
    // 아래 '반올림은 0.5 를 올린다' 시험이 고정한다.
    expect(teamPoint({ finished: true, adjustedFinishSec: 1470, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(51);
    expect(teamPoint({ finished: true, adjustedFinishSec: 1485, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(51);
  });
  it('제출 없이 만료 시각에 완주 인정되면 경계에서 51이다', () => {
    expect(teamPoint({ finished: true, adjustedFinishSec: limit, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(51);
  });
  it('반올림은 0.5 를 올린다(§7.2). 1425초는 식이 50 + round(2.5) = 53', () => {
    // 1485초(식 51)와 1486초(식 50)를 가르는 규칙이 이것이다. 반올림을 짝수 쪽이나 내림으로
    // 바꾸면 이 판은 52가 되어 이 시험이 실패한다. 경계 두 칸은 하한 때문에 결과가 같아
    // 그 변화를 잡지 못한다.
    expect(teamPoint({ finished: true, adjustedFinishSec: 1425, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(53);
  });
  it('절반에 완주하면 75점', () => {
    expect(teamPoint({ finished: true, adjustedFinishSec: 750, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(75);
  });
  it('여유가 있으면 클램프가 물지 않고 원식이 그대로 나온다', () => {
    expect(teamPoint({ finished: true, adjustedFinishSec: 1000, limitSec: limit, correctCells: 54, blankCells: blanks })).toBe(67);
  });
  it('제한 시간의 마지막 1% 에 통과한 제출도 하한이 물린다. 식이 50으로 반올림되기 때문이다', () => {
    // 1500초 판이면 1486~1499초다(§7.2.1 의 두 번째 경우). 1486초는 50 × 14/1500 ≈ 0.47 이라
    // 식이 50이고 하한이 처음 물린다.
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
