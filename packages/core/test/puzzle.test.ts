import { describe, it, expect } from 'vitest';
import { violations, hasUniqueSolution, solveBruteForce, candidates, blankCount } from '../src/sudoku/grid.js';
import { solveLogically, gradePuzzle, nextHint, TECHNIQUE_TIER } from '../src/sudoku/solver.js';
import { generateFullBoard, generatePuzzle, mulberry32, SYMMETRIC } from '../src/sudoku/generator.js';

const P = (s: string): number[] => [...s].map((c) => (c === '.' || c === '0' ? 0 : Number(c)));

describe('격자 · 제약 위반', () => {
  it('제약 위반을 정답 없이 판정한다', () => {
    const cells = new Array(81).fill(0);
    cells[0] = 5; cells[1] = 5;                 // 같은 행
    cells[9 * 2] = 7; cells[9 * 5] = 7;         // 같은 열
    const bad = violations(cells);
    expect(bad.has(0)).toBe(true); expect(bad.has(1)).toBe(true);
    expect(bad.has(18)).toBe(true); expect(bad.has(45)).toBe(true);
  });
  it('위반이 없으면 빈 집합', () => {
    const full = generateFullBoard(mulberry32(7));
    expect(violations(full).size).toBe(0);
  });
});

describe('완성 보드', () => {
  it('같은 시드는 같은 보드를 낸다', () => {
    expect(generateFullBoard(mulberry32(42))).toEqual(generateFullBoard(mulberry32(42)));
  });
  it('다른 시드는 다른 보드를 낸다', () => {
    expect(generateFullBoard(mulberry32(1))).not.toEqual(generateFullBoard(mulberry32(2)));
  });
  it('81칸이 전부 1~9이고 위반이 없다', () => {
    const b = generateFullBoard(mulberry32(99));
    expect(b).toHaveLength(81);
    expect(b.every((v) => v >= 1 && v <= 9)).toBe(true);
    expect(violations(b).size).toBe(0);
  });
});

describe('논리 솔버', () => {
  it('Naked/Hidden Single 만으로 풀리는 퍼즐은 입문이다', () => {
    // 단서가 넉넉한 판
    const g = generatePuzzle('intro', { seed: 12345, maxAttempts: 40 });
    expect(g.puzzle).not.toBeNull();
    const r = solveLogically(g.puzzle!.givens);
    expect(r.solved).toBe(true);
    expect(r.maxTier).toBe(1);
    expect(r.difficulty).toBe('intro');
  });

  it('경로가 모든 빈칸을 덮는다 — 힌트가 지목할 칸이 항상 있다', () => {
    const g = generatePuzzle('normal', { seed: 777, maxAttempts: 60 });
    expect(g.puzzle).not.toBeNull();
    const pz = g.puzzle!;
    expect(pz.path.length).toBe(blankCount(pz.givens));
    const covered = new Set(pz.path.map((s) => s.index));
    for (let i = 0; i < 81; i++) if (!pz.givens[i]) expect(covered.has(i)).toBe(true);
  });

  it('경로의 값이 정답과 일치한다', () => {
    const g = generatePuzzle('hard', { seed: 2024, maxAttempts: 80 });
    expect(g.puzzle).not.toBeNull();
    for (const step of g.puzzle!.path) expect(step.value).toBe(g.puzzle!.solution[step.index]);
  });

  it('시행착오로만 풀리는 퍼즐은 등급을 받지 않는다', () => {
    // 유일해지만 논리 사다리로는 안 풀리는 극악 퍼즐
    // Arto Inkala 의 이른바 '가장 어려운 스도쿠' — 유일해지만 사다리로는 안 풀린다
    const hardest = P('800000000003600000070090200050007000000045700000100030001000068008500010090000400');
    expect(hardest).toHaveLength(81);
    expect(hasUniqueSolution(hardest)).toBe(true);
    const graded = gradePuzzle(hardest);
    expect(graded.difficulty).toBeNull();
  });

  it('솔버의 해가 완전 탐색의 해와 같다', () => {
    const g = generatePuzzle('normal', { seed: 31337, maxAttempts: 60 });
    const pz = g.puzzle!;
    expect(solveBruteForce(pz.givens)).toEqual(pz.solution);
  });
});

describe('힌트', () => {
  it('아직 비어 있는 첫 칸을 지목하고 값은 주지 않는다', () => {
    const pz = generatePuzzle('normal', { seed: 555, maxAttempts: 60 }).puzzle!;
    const board = [...pz.givens];
    const h = nextHint(pz.path, board);
    expect(h).not.toBeNull();
    expect(board[h!.index]).toBe(0);
    expect(Object.keys(h!)).toEqual(['index', 'technique']);   // 값 필드가 없다
    expect(h!.index).toBe(pz.path[0]!.index);
  });

  it('플레이어가 넣은 값이 무엇이든 경로가 달라지지 않는다', () => {
    const pz = generatePuzzle('normal', { seed: 556, maxAttempts: 60 }).puzzle!;
    const wrong = [...pz.givens];
    const firstBlank = wrong.findIndex((v, i) => !v && i !== pz.path[0]!.index);
    wrong[firstBlank] = ((pz.solution[firstBlank]! % 9) + 1);   // 일부러 틀린 값
    const h1 = nextHint(pz.path, pz.givens);
    const h2 = nextHint(pz.path, wrong);
    expect(h2!.index).toBe(h1!.index);   // 지목이 입력값에 반응하지 않는다
  });

  it('빈칸이 없으면 null — 호출부가 버튼을 막는다', () => {
    const pz = generatePuzzle('intro', { seed: 4242, maxAttempts: 40 }).puzzle!;
    expect(nextHint(pz.path, pz.solution)).toBeNull();
    const wrongFull = pz.solution.map((v, i) => (pz.givens[i] ? v : ((v % 9) + 1)));
    expect(nextHint(pz.path, wrongFull)).toBeNull();   // 오답이 섞여 있어도 마찬가지
  });
});

describe('생성 파이프라인 — 유일해와 대칭', () => {
  it('생성된 퍼즐은 항상 유일해다', () => {
    for (const seed of [11, 22, 33]) {
      const pz = generatePuzzle('normal', { seed, maxAttempts: 60 }).puzzle;
      expect(pz).not.toBeNull();
      expect(hasUniqueSolution(pz!.givens)).toBe(true);
    }
  });
  it('입문·보통은 180도 대칭, 어려움 이상은 아니다 (U4)', () => {
    const intro = generatePuzzle('intro', { seed: 808, maxAttempts: 40 }).puzzle!;
    for (let i = 0; i < 81; i++) {
      expect(!!intro.givens[i]).toBe(!!intro.givens[80 - i]);
    }
    expect(SYMMETRIC.hard).toBe(false);
  });
  it('단서 수가 등급별 관찰 범위 안이다', () => {
    const intro = generatePuzzle('intro', { seed: 909, maxAttempts: 40 }).puzzle!;
    // 난이도는 기법 상한이 정하고, 관찰 대역은 파는 깊이를 멈추는 바닥이다
    expect(intro.clues).toBeGreaterThanOrEqual(36);
    expect(intro.clues).toBeLessThanOrEqual(45);
    const ex = generatePuzzle('expert', { seed: 909, maxAttempts: 60 }).puzzle!;
    expect(ex.clues).toBeLessThanOrEqual(30);
    expect(ex.clues).toBeLessThan(intro.clues);
  });
});

describe('기법 사다리', () => {
  it('등급은 동원한 최고 기법으로 정해진다', () => {
    expect(TECHNIQUE_TIER['Naked Single']).toBe(1);
    expect(TECHNIQUE_TIER['Locked Candidates']).toBe(2);
    expect(TECHNIQUE_TIER['Naked Triple']).toBe(3);
    expect(TECHNIQUE_TIER['X-Wing']).toBe(4);
    expect(TECHNIQUE_TIER['Swordfish']).toBe(5);
  });
});
