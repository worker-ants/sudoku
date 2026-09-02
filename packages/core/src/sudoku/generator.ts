/**
 * 생성 파이프라인 (PUZZLE §4)
 *   1. 완성 보드 생성      시드 기반 백트래킹 + 후보 셔플
 *   2. 칸 제거            한 칸씩 지우며 매번 유일해 검증. 해가 둘 이상이면 되돌린다
 *   3. 등급 판정          논리 솔버로 풀며 동원한 최고 기법을 기록
 *   4. 채택 / 폐기        목표 등급과 일치하면 채택, 아니면 폐기
 *
 * **단서 수는 등급의 원인이 아니라 결과다.** 아래 CLUE_RANGE 는 목표가 아니라
 * 그 등급에서 실제로 나오더라는 관찰값이고, 탐색 범위를 좁히는 데만 쓴다.
 */
import { ALL, N, PEERS, bit, maskToValues, popcount, hasUniqueSolution } from './grid.js';
import { type Difficulty, gradePuzzle, solveLogically, type SolveStep, type Technique } from './solver.js';

export interface PuzzleRecord {
  puzzleId: string;
  seed: number;
  givens: number[];
  /** 서버 안에만 있는 값. 전송 타입에는 이 필드가 없다(ADR-STACK S4) */
  solution: number[];
  difficulty: Difficulty;
  techniques: Technique[];
  /** 힌트가 재생할 풀이 경로 — 생성 시점에 계산해 저장한다(PUZZLE §4.1) */
  path: SolveStep[];
  clues: number;
  createdAtEpochMs: number;
}

/** U4 — 입문·보통은 180도 회전 대칭 유지, 어려움 이상은 대칭 없음 */
export const SYMMETRIC: Record<Difficulty, boolean> = {
  intro: true, normal: true, hard: false, expert: false, nightmare: false,
};
/** 목표 등급이 허용하는 기법 사다리의 상한 — **난이도를 정하는 것은 이 값이다** */
const DIFFICULTY_TIER: Record<Difficulty, number> = {
  intro: 1, normal: 2, hard: 3, expert: 4, nightmare: 5,
};
/**
 * 등급별로 실제로 관찰되는 단서 수 대역(PUZZLE §3의 표).
 *
 * **이 값은 난이도를 정하지 않는다.** 정하는 것은 위의 기법 상한이고, 이 대역은
 * **어디까지 팔지를 멈추는 바닥**으로만 쓴다. 상한만 두고 최대한 파면 어느 등급이든
 * 최소 단서 근처로 내려가 — 입문도 28개까지 간다 — 표의 관찰값과 어긋난다.
 * 두 서술을 이렇게 화해시킨다: 사다리가 등급을 정하고, 대역이 깊이를 멈춘다.
 */
const CLUE_FLOOR: Record<Difficulty, [number, number]> = {
  intro: [36, 45], normal: [30, 36], hard: [26, 32], expert: [24, 30], nightmare: [22, 28],
};

/** 시드 RNG — 같은 시드는 같은 퍼즐을 낸다(PUZZLE §4 재현성) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = <T,>(arr: T[], rng: () => number): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

/** 1단계 — 완성 보드 */
export function generateFullBoard(rng: () => number): number[] {
  const cells = new Array<number>(N).fill(0);
  const rec = (): boolean => {
    let best = -1, bestMask = 0, bestCount = 10;
    for (let i = 0; i < N; i++) {
      if (cells[i]) continue;
      let m = ALL;
      for (const p of PEERS[i]!) { const v = cells[p]!; if (v) m &= ~bit(v); }
      const c = popcount(m);
      if (c === 0) return false;
      if (c < bestCount) { bestCount = c; best = i; bestMask = m; if (c === 1) break; }
    }
    if (best === -1) return true;
    for (const v of shuffle(maskToValues(bestMask), rng)) {
      cells[best] = v;
      if (rec()) return true;
      cells[best] = 0;
    }
    return false;
  };
  if (!rec()) throw new Error('완성 보드 생성 실패');
  return cells;
}

/**
 * 2단계 — 칸 제거.
 *
 * **단서 수를 목표로 잡지 않는다.** PUZZLE §3이 "단서 수는 등급의 원인이 아니라 결과"라고
 * 적었으므로, 파는 기준도 개수가 아니라 **기법 상한**이다 — 목표 등급의 사다리 안에서
 * 논리로 풀리는 동안 계속 파고, 그 상한을 넘겨야 풀리는 순간 되돌린다.
 *
 * 파는 중의 합격 판정으로 논리 풀이를 쓰는 것이 완전 탐색보다 싸고, 사다리 1~4단으로
 * 풀린 배치는 해가 유일하다(사운드한 기법만 쓰기 때문이다). Unique Rectangle 은 유일성을
 * *가정*하므로 5단에서는 그것으로 대신할 수 없어, **마지막에 한 번 완전 탐색으로 확인한다.**
 */
function dig(
  solution: readonly number[], tierCap: number, floor: number,
  symmetric: boolean, rng: () => number,
): number[] {
  const givens = [...solution];
  let clues = N;
  const order = shuffle(Array.from({ length: N }, (_, i) => i), rng);

  for (const i of order) {
    // 바닥에 닿았고 목표 기법이 이미 필요해졌으면 멈춘다.
    // 아직 더 쉬운 사다리로 풀린다면 목표 기법이 필요해질 때까지 더 판다 —
    // 그래야 "그 등급이 되는 최소한의 파기"에서 멈춘다.
    // 입문(1단)에는 비교할 아래 사다리가 없으므로 바닥이 곧 정지 조건이다.
    if (clues <= floor && (tierCap === 1 || !solveLogically(givens, tierCap - 1).solved)) break;
    const pair = N - 1 - i;
    const group = symmetric && pair !== i ? [i, pair] : [i];
    if (group.some((g) => !givens[g])) continue;
    const backup = group.map((g) => givens[g]!);
    for (const g of group) givens[g] = 0;
    if (!solveLogically(givens, tierCap).solved) {
      group.forEach((g, k) => { givens[g] = backup[k]!; });
    } else {
      clues -= group.length;
    }
  }
  return givens;
}

export interface GenerateOptions {
  /** 목표 등급과 다르면 폐기하고 다시 시도한다. 이 횟수를 넘으면 포기 */
  maxAttempts?: number;
  /** 시도마다 소비되는 시드의 시작값 */
  seed?: number;
  now?: () => number;
}

export interface GenerateOutcome {
  puzzle: PuzzleRecord | null;
  attempts: number;
  /** 폐기율의 원자료 — 목표와 다른 등급이 몇 번 나왔나 */
  discardedAs: Partial<Record<Difficulty | 'unsolvable', number>>;
}

/** 3·4단계 — 등급 판정과 채택/폐기 */
export function generatePuzzle(target: Difficulty, opts: GenerateOptions = {}): GenerateOutcome {
  /**
   * 기본 400. 등급이 올라갈수록 시도 수가 급격히 늘어난다 — 악몽 등급은 12표본 측정에서
   * 중앙 86회·최대 193회였고, **이전 기본값 60 으로는 16번 중 7번만 성공했다.**
   * 운영 경로(퍼즐 풀)는 진작 400 을 넘기고 있었으므로 기본값만 그 자리로 맞춘다.
   */
  const maxAttempts = opts.maxAttempts ?? 400;
  const now = opts.now ?? (() => Date.now());
  let seed = opts.seed ?? (Math.random() * 2 ** 31) | 0;
  const discardedAs: GenerateOutcome['discardedAs'] = {};
  const tierCap = DIFFICULTY_TIER[target];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const rng = mulberry32(seed);
    const solution = generateFullBoard(rng);
    const [lo, hi] = CLUE_FLOOR[target];
    const floor = lo + Math.floor(rng() * (hi - lo + 1));
    const givens = dig(solution, tierCap, floor, SYMMETRIC[target], rng);
    const graded = gradePuzzle(givens);

    // 사다리 5단은 유일성을 가정하는 기법(UR)을 쓰므로 여기서 한 번 확인한다
    const unique = tierCap < 5 || hasUniqueSolution(givens);

    if (unique && graded.difficulty === target) {
      const clues = givens.reduce((a, v) => a + (v ? 1 : 0), 0);
      return {
        puzzle: {
          puzzleId: `pz_${(seed >>> 0).toString(36)}_${target}`,
          seed, givens, solution,
          difficulty: target,
          techniques: graded.techniques,
          path: graded.path,
          clues,
          createdAtEpochMs: now(),
        },
        attempts: attempt,
        discardedAs,
      };
    }
    const key = !unique ? 'unsolvable' : (graded.difficulty ?? 'unsolvable');
    discardedAs[key] = (discardedAs[key] ?? 0) + 1;
    seed = (seed + 0x9e3779b9) | 0;
  }
  return { puzzle: null, attempts: maxAttempts, discardedAs };
}
