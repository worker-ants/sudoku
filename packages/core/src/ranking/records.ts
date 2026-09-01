/**
 * 기록 랭킹 (DSN-RANKING §5)
 * **브래킷이 걸리는 유일한 축이다**(R6). 협동은 인원 구간을 하나 더 곱한다.
 */
import type { Difficulty } from '../sudoku/solver.js';
import type { Mode } from '../rules/rules.js';

export type SizeBand = '2' | '3-4' | '5+';
export const sizeBandOf = (n: number): SizeBand => (n <= 2 ? '2' : n <= 4 ? '3-4' : '5+');

/** 레이스 5 + 협동 5×3 = 실제 보드 20개 */
export const bracketKey = (mode: Mode, difficulty: Difficulty, members?: number): string =>
  mode === 'race' ? `race:${difficulty}` : `coop:${difficulty}:${sizeBandOf(members ?? 2)}`;

export const ALL_BRACKETS = ((): string[] => {
  const ds: Difficulty[] = ['intro', 'normal', 'hard', 'expert', 'nightmare'];
  const out: string[] = [];
  for (const d of ds) out.push(`race:${d}`);
  for (const d of ds) for (const b of ['2', '3-4', '5+'] as SizeBand[]) out.push(`coop:${d}:${b}`);
  return out;
})();

/**
 * 엔트리 단위 (R9)
 *  - 레이스: 참가자 한 명이 한 줄
 *  - 협동: **판 하나가 한 줄**, 이름 자리에는 게이트를 통과한 참가자 명단
 */
export interface RecordEntry {
  bracket: string;
  matchId: string;
  puzzleId: string;
  adjustedFinishSec: number;
  atEpochMs: number;
  /** 레이스는 한 명, 협동은 게이트 통과자 전원 */
  holders: { accountId: string; nickname: string }[];
  mode: Mode;
}

export function buildRecordEntries(input: {
  mode: Mode; difficulty: Difficulty; matchId: string; puzzleId: string; atEpochMs: number;
  startingMembers: number;
  race?: { accountId: string; nickname: string; finished: boolean; adjustedFinishSec: number | null }[];
  coop?: { finished: boolean; adjustedFinishSec: number | null; passers: { accountId: string; nickname: string }[] };
}): RecordEntry[] {
  const { mode, difficulty, matchId, puzzleId, atEpochMs } = input;
  if (mode === 'race') {
    const bracket = bracketKey('race', difficulty);
    return (input.race ?? [])
      .filter((p) => p.finished && p.adjustedFinishSec !== null)
      .map((p) => ({
        bracket, matchId, puzzleId, atEpochMs, mode,
        adjustedFinishSec: p.adjustedFinishSec!,
        holders: [{ accountId: p.accountId, nickname: p.nickname }],
      }));
  }
  const c = input.coop;
  if (!c || !c.finished || c.adjustedFinishSec === null) return [];
  return [{
    bracket: bracketKey('coop', difficulty, input.startingMembers),
    matchId, puzzleId, atEpochMs, mode,
    adjustedFinishSec: c.adjustedFinishSec,
    holders: c.passers,
  }];
}

/** 브래킷별 최소값 + 전체 상위 100 */
export function topRecords(entries: RecordEntry[], bracket: string, limit = 100): RecordEntry[] {
  return entries.filter((e) => e.bracket === bracket)
    .sort((a, b) => a.adjustedFinishSec - b.adjustedFinishSec || a.atEpochMs - b.atEpochMs)
    .slice(0, limit);
}
