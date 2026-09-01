/**
 * 논리 솔버 — 등급 판정(PUZZLE §3)과 힌트(AREA-PLAY §1.4)가 **같은 솔버를 쓴다.**
 *
 * 기법 사다리 5단. 동원한 기법 중 **가장 높은 것**이 그 퍼즐의 등급이다.
 * 시행착오(찍고 되돌리기)로만 풀리는 퍼즐은 어느 등급에도 넣지 않고 폐기한다.
 */
import {
  ALL, BOXES, COLS, N, PEERS, ROWS, UNITS, bit, boxOf, colOf,
  candidates, lowestBitValue, maskToValues, popcount, rowOf, sees,
} from './grid.js';

export type Difficulty = 'intro' | 'normal' | 'hard' | 'expert' | 'nightmare';
export const DIFFICULTIES: Difficulty[] = ['intro', 'normal', 'hard', 'expert', 'nightmare'];

/** 기법 → 그 기법이 속한 등급 단계(PUZZLE §3 표) */
export const TECHNIQUE_TIER = {
  'Naked Single': 1, 'Hidden Single': 1,
  'Locked Candidates': 2,
  'Naked Pair': 3, 'Naked Triple': 3, 'Hidden Pair': 3, 'Hidden Triple': 3,
  'X-Wing': 4, 'XY-Wing': 4, 'Simple Coloring': 4,
  'Swordfish': 5, 'XYZ-Wing': 5, 'Unique Rectangle': 5,
} as const;
export type Technique = keyof typeof TECHNIQUE_TIER;
export const TIER_TO_DIFFICULTY: Record<number, Difficulty> = {
  1: 'intro', 2: 'normal', 3: 'hard', 4: 'expert', 5: 'nightmare',
};

export interface SolveStep {
  index: number;
  value: number;
  /** 이 칸이 풀린 근거가 된 기법. 힌트가 사람에게 말해 주는 이름이다 */
  technique: Technique;
  tier: number;
}
export interface SolveResult {
  solved: boolean;
  /** 동원한 최고 기법 단계(1~5). 못 풀었으면 도달한 데까지 */
  maxTier: number;
  difficulty: Difficulty | null;
  path: SolveStep[];
  techniques: Technique[];
}

interface Ctx { cells: number[]; cand: number[]; }

const place = (x: Ctx, i: number, v: number): void => {
  x.cells[i] = v;
  x.cand[i] = 0;
  for (const p of PEERS[i]!) x.cand[p]! &= ~bit(v);
};

// ── 배치 기법 ──────────────────────────────────────────────────────────────
function nakedSingle(x: Ctx): { index: number; value: number } | null {
  for (let i = 0; i < N; i++) {
    if (x.cells[i]) continue;
    if (popcount(x.cand[i]!) === 1) return { index: i, value: lowestBitValue(x.cand[i]!) };
  }
  return null;
}
function hiddenSingle(x: Ctx): { index: number; value: number } | null {
  for (const unit of UNITS) {
    for (let v = 1; v <= 9; v++) {
      const b = bit(v);
      let spot = -1, count = 0, taken = false;
      for (const i of unit) {
        if (x.cells[i] === v) { taken = true; break; }
        if (!x.cells[i] && (x.cand[i]! & b)) { spot = i; count++; }
      }
      if (!taken && count === 1) return { index: spot, value: v };
    }
  }
  return null;
}

// ── 소거 기법 ──────────────────────────────────────────────────────────────
function lockedCandidates(x: Ctx): boolean {
  let changed = false;
  for (let v = 1; v <= 9; v++) {
    const b = bit(v);
    // Pointing — 박스 안에서 한 행/열에 몰리면 그 행/열의 박스 밖에서 지운다
    for (let bx = 0; bx < 9; bx++) {
      const spots = BOXES[bx]!.filter((i) => !x.cells[i] && (x.cand[i]! & b));
      if (spots.length < 2) continue;
      const rs = new Set(spots.map(rowOf)), cs = new Set(spots.map(colOf));
      if (rs.size === 1) {
        for (const i of ROWS[[...rs][0]!]!) if (boxOf(i) !== bx && !x.cells[i] && (x.cand[i]! & b)) { x.cand[i]! &= ~b; changed = true; }
      }
      if (cs.size === 1) {
        for (const i of COLS[[...cs][0]!]!) if (boxOf(i) !== bx && !x.cells[i] && (x.cand[i]! & b)) { x.cand[i]! &= ~b; changed = true; }
      }
    }
    // Claiming — 행/열 안에서 한 박스에 몰리면 그 박스의 행/열 밖에서 지운다
    for (const line of [...ROWS, ...COLS]) {
      const spots = line.filter((i) => !x.cells[i] && (x.cand[i]! & b));
      if (spots.length < 2) continue;
      const bs = new Set(spots.map(boxOf));
      if (bs.size !== 1) continue;
      const only = [...bs][0]!;
      const inLine = new Set(line);
      for (const i of BOXES[only]!) if (!inLine.has(i) && !x.cells[i] && (x.cand[i]! & b)) { x.cand[i]! &= ~b; changed = true; }
    }
  }
  return changed;
}

function nakedSet(x: Ctx, size: 2 | 3): boolean {
  let changed = false;
  for (const unit of UNITS) {
    const open = unit.filter((i) => !x.cells[i]);
    if (open.length <= size) continue;
    const combo = (start: number, picked: number[], mask: number): void => {
      if (picked.length === size) {
        if (popcount(mask) !== size) return;
        for (const i of open) {
          if (picked.includes(i)) continue;
          if (x.cand[i]! & mask) { x.cand[i]! &= ~mask; changed = true; }
        }
        return;
      }
      for (let k = start; k < open.length; k++) {
        const i = open[k]!;
        const m = mask | x.cand[i]!;
        if (popcount(m) > size) continue;
        combo(k + 1, [...picked, i], m);
      }
    };
    combo(0, [], 0);
  }
  return changed;
}

function hiddenSet(x: Ctx, size: 2 | 3): boolean {
  let changed = false;
  for (const unit of UNITS) {
    const open = unit.filter((i) => !x.cells[i]);
    if (open.length <= size) continue;
    const digits: number[] = [];
    for (let v = 1; v <= 9; v++) if (open.some((i) => x.cand[i]! & bit(v))) digits.push(v);
    const combo = (start: number, picked: number[]): void => {
      if (picked.length === size) {
        const mask = picked.reduce((a, v) => a | bit(v), 0);
        const spots = open.filter((i) => x.cand[i]! & mask);
        if (spots.length !== size) return;
        // 고른 숫자들이 이 칸들에만 있는지
        for (const v of picked) if (!open.some((i) => spots.includes(i) && (x.cand[i]! & bit(v)))) return;
        for (const i of spots) if (x.cand[i]! & ~mask) { x.cand[i]! &= mask; changed = true; }
        return;
      }
      for (let k = start; k < digits.length; k++) combo(k + 1, [...picked, digits[k]!]);
    };
    combo(0, []);
  }
  return changed;
}

/** X-Wing(size 2) · Swordfish(size 3) — 행 기준과 열 기준 양쪽 */
function fish(x: Ctx, size: 2 | 3): boolean {
  let changed = false;
  for (let v = 1; v <= 9; v++) {
    const b = bit(v);
    for (const orient of [0, 1]) {
      const lines = orient === 0 ? ROWS : COLS;
      const cross = orient === 0 ? COLS : ROWS;
      const spots = lines.map((line) => line.filter((i) => !x.cells[i] && (x.cand[i]! & b)));
      const usable = spots.map((s, li) => ({ li, keys: s.map((i) => (orient === 0 ? colOf(i) : rowOf(i))) }))
        .filter((e) => e.keys.length >= 2 && e.keys.length <= size);
      const combo = (start: number, picked: number[], keys: Set<number>): void => {
        if (picked.length === size) {
          if (keys.size !== size) return;
          for (const k of keys) {
            for (const i of cross[k]!) {
              const li = orient === 0 ? rowOf(i) : colOf(i);
              if (picked.includes(li)) continue;
              if (!x.cells[i] && (x.cand[i]! & b)) { x.cand[i]! &= ~b; changed = true; }
            }
          }
          return;
        }
        for (let k = start; k < usable.length; k++) {
          const e = usable[k]!;
          const next = new Set([...keys, ...e.keys]);
          if (next.size > size) continue;
          combo(k + 1, [...picked, e.li], next);
        }
      };
      combo(0, [], new Set());
    }
  }
  return changed;
}

function xyWing(x: Ctx): boolean {
  let changed = false;
  const two = [] as number[];
  for (let i = 0; i < N; i++) if (!x.cells[i] && popcount(x.cand[i]!) === 2) two.push(i);
  for (const pivot of two) {
    const [a, b] = maskToValues(x.cand[pivot]!) as [number, number];
    for (const p1 of two) {
      if (p1 === pivot || !sees(pivot, p1)) continue;
      const m1 = maskToValues(x.cand[p1]!);
      if (!m1.includes(a) || m1.includes(b)) continue;
      const c = m1.find((v) => v !== a)!;
      for (const p2 of two) {
        if (p2 === pivot || p2 === p1 || !sees(pivot, p2)) continue;
        const m2 = maskToValues(x.cand[p2]!);
        if (!m2.includes(b) || !m2.includes(c)) continue;
        for (let i = 0; i < N; i++) {
          if (x.cells[i] || i === p1 || i === p2 || i === pivot) continue;
          if (sees(i, p1) && sees(i, p2) && (x.cand[i]! & bit(c))) { x.cand[i]! &= ~bit(c); changed = true; }
        }
      }
    }
  }
  return changed;
}

function xyzWing(x: Ctx): boolean {
  let changed = false;
  for (let pivot = 0; pivot < N; pivot++) {
    if (x.cells[pivot] || popcount(x.cand[pivot]!) !== 3) continue;
    const pv = maskToValues(x.cand[pivot]!);
    for (const p1 of PEERS[pivot]!) {
      if (x.cells[p1] || popcount(x.cand[p1]!) !== 2) continue;
      if ((x.cand[p1]! & x.cand[pivot]!) !== x.cand[p1]!) continue;
      for (const p2 of PEERS[pivot]!) {
        if (p2 === p1 || x.cells[p2] || popcount(x.cand[p2]!) !== 2) continue;
        if ((x.cand[p2]! & x.cand[pivot]!) !== x.cand[p2]!) continue;
        const shared = x.cand[p1]! & x.cand[p2]!;
        if (popcount(shared) !== 1) continue;
        if ((x.cand[p1]! | x.cand[p2]!) !== x.cand[pivot]!) continue;
        const c = lowestBitValue(shared);
        if (!pv.includes(c)) continue;
        for (let i = 0; i < N; i++) {
          if (x.cells[i] || i === pivot || i === p1 || i === p2) continue;
          if (sees(i, pivot) && sees(i, p1) && sees(i, p2) && (x.cand[i]! & bit(c))) { x.cand[i]! &= ~bit(c); changed = true; }
        }
      }
    }
  }
  return changed;
}

/** Simple Coloring — 켤레쌍 그래프를 2색으로 칠하고 모순을 찾는다 */
function simpleColoring(x: Ctx): boolean {
  let changed = false;
  for (let v = 1; v <= 9; v++) {
    const b = bit(v);
    const adj = new Map<number, number[]>();
    for (const unit of UNITS) {
      const spots = unit.filter((i) => !x.cells[i] && (x.cand[i]! & b));
      if (spots.length !== 2) continue;
      const [p, q] = spots as [number, number];
      (adj.get(p) ?? adj.set(p, []).get(p)!).push(q);
      (adj.get(q) ?? adj.set(q, []).get(q)!).push(p);
    }
    const color = new Map<number, 0 | 1>();
    for (const start of adj.keys()) {
      if (color.has(start)) continue;
      const comp: number[] = [];
      color.set(start, 0);
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        comp.push(cur);
        for (const nx of adj.get(cur) ?? []) {
          if (!color.has(nx)) { color.set(nx, color.get(cur) === 0 ? 1 : 0); stack.push(nx); }
        }
      }
      // 같은 색 두 칸이 서로 보이면 그 색은 전부 거짓
      for (const c of [0, 1] as const) {
        const same = comp.filter((i) => color.get(i) === c);
        let bad = false;
        for (let a = 0; a < same.length && !bad; a++)
          for (let d = a + 1; d < same.length; d++) if (sees(same[a]!, same[d]!)) { bad = true; break; }
        if (bad) for (const i of same) if (x.cand[i]! & b) { x.cand[i]! &= ~b; changed = true; }
      }
      // 두 색을 모두 보는 칸에서는 지운다
      const c0 = comp.filter((i) => color.get(i) === 0), c1 = comp.filter((i) => color.get(i) === 1);
      if (c0.length && c1.length) {
        for (let i = 0; i < N; i++) {
          if (x.cells[i] || comp.includes(i) || !(x.cand[i]! & b)) continue;
          if (c0.some((p) => sees(i, p)) && c1.some((p) => sees(i, p))) { x.cand[i]! &= ~b; changed = true; }
        }
      }
    }
  }
  return changed;
}

/** Unique Rectangle Type 1 — 두 박스에 걸친 직사각형에서 유일해 가정을 쓴다 */
function uniqueRectangle(x: Ctx): boolean {
  let changed = false;
  for (let r1 = 0; r1 < 9; r1++) for (let r2 = r1 + 1; r2 < 9; r2++)
    for (let c1 = 0; c1 < 9; c1++) for (let c2 = c1 + 1; c2 < 9; c2++) {
      const cs = [r1 * 9 + c1, r1 * 9 + c2, r2 * 9 + c1, r2 * 9 + c2];
      if (cs.some((i) => x.cells[i])) continue;
      if (new Set(cs.map(boxOf)).size !== 2) continue;
      const bi = cs.filter((i) => popcount(x.cand[i]!) === 2);
      if (bi.length !== 3) continue;
      const m = x.cand[bi[0]!]!;
      if (x.cand[bi[1]!] !== m || x.cand[bi[2]!] !== m) continue;
      const extra = cs.find((i) => !bi.includes(i))!;
      if ((x.cand[extra]! & m) !== m) continue;
      if (popcount(x.cand[extra]!) <= 2) continue;
      x.cand[extra]! &= ~m; changed = true;
    }
  return changed;
}

const ELIMINATORS: { name: Technique; fn: (x: Ctx) => boolean }[] = [
  { name: 'Locked Candidates', fn: lockedCandidates },
  { name: 'Naked Pair', fn: (x) => nakedSet(x, 2) },
  { name: 'Hidden Pair', fn: (x) => hiddenSet(x, 2) },
  { name: 'Naked Triple', fn: (x) => nakedSet(x, 3) },
  { name: 'Hidden Triple', fn: (x) => hiddenSet(x, 3) },
  { name: 'X-Wing', fn: (x) => fish(x, 2) },
  { name: 'XY-Wing', fn: xyWing },
  { name: 'Simple Coloring', fn: simpleColoring },
  { name: 'Swordfish', fn: (x) => fish(x, 3) },
  { name: 'XYZ-Wing', fn: xyzWing },
  { name: 'Unique Rectangle', fn: uniqueRectangle },
];

/**
 * 원본 단서에서 풀이 경로를 만든다.
 * **플레이어가 넣은 값은 보지 않는다** — 힌트의 계산 입력이 원본 단서로 못 박혀 있기 때문이다
 * (AREA-PLAY §1.4의 절대 규칙). 그래서 경로는 퍼즐마다 하나로 고정된다.
 */
export function solveLogically(givens: readonly number[], maxTier = 5): SolveResult {
  const x: Ctx = { cells: [...givens], cand: candidates(givens) };
  const path: SolveStep[] = [];
  const used = new Set<Technique>();
  let highest = 0;
  let pendingTechnique: Technique | null = null;

  for (;;) {
    const ns = nakedSingle(x);
    if (ns) {
      const tech: Technique = pendingTechnique ?? 'Naked Single';
      used.add(tech); used.add('Naked Single');
      highest = Math.max(highest, TECHNIQUE_TIER[tech], 1);
      path.push({ index: ns.index, value: ns.value, technique: tech, tier: TECHNIQUE_TIER[tech] });
      place(x, ns.index, ns.value);
      pendingTechnique = null;
      continue;
    }
    const hs = hiddenSingle(x);
    if (hs) {
      const tech: Technique = pendingTechnique ?? 'Hidden Single';
      used.add(tech); used.add('Hidden Single');
      highest = Math.max(highest, TECHNIQUE_TIER[tech], 1);
      path.push({ index: hs.index, value: hs.value, technique: tech, tier: TECHNIQUE_TIER[tech] });
      place(x, hs.index, hs.value);
      pendingTechnique = null;
      continue;
    }
    if (x.cells.every((v) => v > 0)) break;

    let progressed = false;
    for (const e of ELIMINATORS) {
      if (TECHNIQUE_TIER[e.name] > maxTier) continue;
      if (e.fn(x)) {
        used.add(e.name);
        highest = Math.max(highest, TECHNIQUE_TIER[e.name]);
        pendingTechnique = e.name;
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }

  const solved = x.cells.every((v) => v > 0);
  return {
    solved,
    maxTier: highest,
    difficulty: solved ? (TIER_TO_DIFFICULTY[Math.max(highest, 1)] ?? null) : null,
    path,
    techniques: [...used],
  };
}

/** 등급 판정 — 논리로 끝까지 풀리지 않으면 어느 등급에도 넣지 않는다(PUZZLE §3) */
export function gradePuzzle(givens: readonly number[]): { difficulty: Difficulty | null; techniques: Technique[]; path: SolveStep[] } {
  const r = solveLogically(givens);
  if (!r.solved) return { difficulty: null, techniques: r.techniques, path: r.path };
  return { difficulty: r.difficulty, techniques: r.techniques, path: r.path };
}

/**
 * 힌트 — 경로 위에서 **아직 비어 있는 첫 칸**을 지목한다.
 * 값은 돌려주지 않는다. 반환 타입에 값 필드가 없는 것이 그 규칙의 구현이다.
 * 빈칸이 없으면 null — 호출부가 버튼을 비활성화한다(AREA-PLAY §1.4).
 */
export function nextHint(path: readonly SolveStep[], board: readonly number[]): { index: number; technique: string } | null {
  for (const step of path) {
    if (!board[step.index]) return { index: step.index, technique: step.technique };
  }
  return null;
}
