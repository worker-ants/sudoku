/**
 * 시즌 포인트 (DSN-RANKING §4)
 * 브래킷으로 나누지 않는다 — 통합 1벌이고 일일 상한도 전체 기준이다(R6).
 */
import { utcDayKey } from '../time/window.js';

export const DAILY_MATCH_CAP = 20;

/** weight(N) = min(1.0, 0.5 + 0.1 × N) — rankPoint 에만 붙는다(R7) */
export const weightForPlayers = (n: number): number => Math.min(1.0, 0.5 + 0.1 * n);

export interface SeasonContribution {
  /** 레이스에서 얻은 순위 포인트 */
  rankPoint?: number;
  /** 협동에서 얻은 팀 포인트 — **가중치가 붙지 않는다**(R7) */
  teamPoint?: number;
  playerCount: number;
}

/** 시즌 기여 = rankPoint × weight(N) + teamPoint */
export function seasonContribution(c: SeasonContribution): number {
  const fromRace = c.rankPoint !== undefined ? c.rankPoint * weightForPlayers(c.playerCount) : 0;
  const fromCoop = c.teamPoint ?? 0;
  return Math.round(fromRace + fromCoop);
}

export interface DailyEntry { atEpochMs: number; points: number }

/**
 * 일일 집계 상한 — 하루에 집계되는 랭크 판을 **상위 20판**으로 제한한다.
 * 하루의 경계는 UTC 자정이다(R10).
 */
export function applyDailyCap(entries: DailyEntry[]): number {
  const byDay = new Map<string, number[]>();
  for (const e of entries) {
    const k = utcDayKey(e.atEpochMs);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(e.points);
  }
  let total = 0;
  for (const pts of byDay.values()) {
    total += pts.sort((a, b) => b - a).slice(0, DAILY_MATCH_CAP).reduce((a, b) => a + b, 0);
  }
  return total;
}
