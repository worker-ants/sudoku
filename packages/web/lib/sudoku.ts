'use client';
/** 클라이언트가 정답 없이 판정할 수 있는 것 — 제약 위반뿐이다 (AREA-PLAY §1.1) */
const UNITS: number[][] = [];
for (let r = 0; r < 9; r++) UNITS.push(Array.from({ length: 9 }, (_, c) => r * 9 + c));
for (let c = 0; c < 9; c++) UNITS.push(Array.from({ length: 9 }, (_, r) => r * 9 + c));
for (let b = 0; b < 9; b++) {
  const r0 = Math.floor(b / 3) * 3, c0 = (b % 3) * 3;
  const u: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) u.push((r0 + r) * 9 + c0 + c);
  UNITS.push(u);
}
export function violations(cells: number[]): Set<number> {
  const bad = new Set<number>();
  for (const unit of UNITS) {
    const seen = new Map<number, number[]>();
    for (const i of unit) {
      const v = cells[i] ?? 0;
      if (!v) continue;
      const l = seen.get(v); if (l) l.push(i); else seen.set(v, [i]);
    }
    for (const l of seen.values()) if (l.length > 1) for (const i of l) bad.add(i);
  }
  return bad;
}
export const peersOf = (i: number): Set<number> => {
  const s = new Set<number>();
  for (const u of UNITS) if (u.includes(i)) for (const j of u) s.add(j);
  s.delete(i);
  return s;
};
export const isFull = (c: number[]): boolean => c.every((v) => v > 0);
export const fmtSec = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
export const COLORS = ['#2f6f5e', '#8a5a2b', '#5a5f8c', '#8a2b5a', '#2b6f8a', '#6f8a2b', '#8a2b2b', '#4a4a4a'];
export const DIFF_LABEL: Record<string, string> = { intro: '입문', normal: '보통', hard: '어려움', expert: '전문가', nightmare: '악몽' };
