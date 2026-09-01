/** 9×9 격자의 뼈대. 후보는 1~9 를 비트 1..9 로 담는 마스크다. */
export const N = 81;
export const ALL = 0b1111111110; // 비트 1..9

export const bit = (v: number): number => 1 << v;
export const rowOf = (i: number): number => (i / 9) | 0;
export const colOf = (i: number): number => i % 9;
export const boxOf = (i: number): number => ((rowOf(i) / 3) | 0) * 3 + ((colOf(i) / 3) | 0);

export const ROWS: number[][] = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (_, c) => r * 9 + c));
export const COLS: number[][] = Array.from({ length: 9 }, (_, c) => Array.from({ length: 9 }, (_, r) => r * 9 + c));
export const BOXES: number[][] = Array.from({ length: 9 }, (_, b) => {
  const r0 = ((b / 3) | 0) * 3, c0 = (b % 3) * 3;
  const out: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push((r0 + r) * 9 + c0 + c);
  return out;
});
/** 27개 단위(행 9 · 열 9 · 박스 9) */
export const UNITS: number[][] = [...ROWS, ...COLS, ...BOXES];

/** 같은 행·열·박스를 공유하는 칸들 — 자기 자신은 뺀다 */
export const PEERS: number[][] = Array.from({ length: N }, (_, i) => {
  const s = new Set<number>();
  for (const u of [ROWS[rowOf(i)]!, COLS[colOf(i)]!, BOXES[boxOf(i)]!]) for (const j of u) s.add(j);
  s.delete(i);
  return [...s];
});
const PEER_SETS: Set<number>[] = PEERS.map((p) => new Set(p));
export const sees = (a: number, b: number): boolean => a !== b && PEER_SETS[a]!.has(b);

export const popcount = (m: number): number => {
  let n = 0;
  while (m) { m &= m - 1; n++; }
  return n;
};
export const lowestBitValue = (m: number): number => 31 - Math.clz32(m & -m);
export const maskToValues = (m: number): number[] => {
  const out: number[] = [];
  for (let v = 1; v <= 9; v++) if (m & bit(v)) out.push(v);
  return out;
};

/**
 * 제약 위반 — 같은 행·열·박스에 같은 숫자.
 * **정답 없이 판정된다**(AREA-PLAY §1.1). 클라이언트가 즉시 계산할 수 있는 정보다.
 */
export function violations(cells: readonly number[]): Set<number> {
  const bad = new Set<number>();
  for (const unit of UNITS) {
    const seen = new Map<number, number[]>();
    for (const i of unit) {
      const v = cells[i] ?? 0;
      if (!v) continue;
      const list = seen.get(v);
      if (list) list.push(i); else seen.set(v, [i]);
    }
    for (const list of seen.values()) if (list.length > 1) for (const i of list) bad.add(i);
  }
  return bad;
}

export const isFull = (cells: readonly number[]): boolean => cells.every((v) => v > 0);
export const filledCount = (cells: readonly number[], givens: readonly number[]): number => {
  let n = 0;
  for (let i = 0; i < N; i++) if (!givens[i] && (cells[i] ?? 0) > 0) n++;
  return n;
};
export const blankCount = (givens: readonly number[]): number => givens.reduce((a, v) => a + (v ? 0 : 1), 0);

/** 후보 마스크 계산 — 현재 배치에서 각 빈칸에 들어갈 수 있는 값 */
export function candidates(cells: readonly number[]): number[] {
  const cand = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    if (cells[i]) continue;
    let m = ALL;
    for (const p of PEERS[i]!) {
      const v = cells[p] ?? 0;
      if (v) m &= ~bit(v);
    }
    cand[i] = m;
  }
  return cand;
}

/** 유일해 검증용 완전 탐색 — 해가 둘 발견되면 즉시 멈춘다 */
export function countSolutions(givens: readonly number[], cap = 2): number {
  const cells = [...givens];
  let found = 0;
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
    if (best === -1) { found++; return found >= cap; }
    for (const v of maskToValues(bestMask)) {
      cells[best] = v;
      if (rec()) { cells[best] = 0; return true; }
      cells[best] = 0;
    }
    return false;
  };
  rec();
  return found;
}

export const hasUniqueSolution = (givens: readonly number[]): boolean => countSolutions(givens, 2) === 1;

/** 완전 탐색으로 하나의 해를 구한다 — 채점용 정답 산출에 쓴다 */
export function solveBruteForce(givens: readonly number[]): number[] | null {
  const cells = [...givens];
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
    for (const v of maskToValues(bestMask)) {
      cells[best] = v;
      if (rec()) return true;
      cells[best] = 0;
    }
    return false;
  };
  return rec() ? cells : null;
}
