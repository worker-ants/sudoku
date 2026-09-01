/**
 * 승부 판정과 점수 (DSN-SCORING)
 *
 * 판정은 순서로, 누적은 포인트로 분리한다 — 후보 C 하이브리드(D1).
 */
export const SUBMIT_LIMIT = 5;
export const HINT_LIMIT = 3;

/** n번째 오답 제출에 +30n초 누진 (D6) */
export const penaltyForNthWrongSubmit = (n: number): number => 30 * n;
export const totalPenaltySec = (wrongSubmits: number): number => {
  let s = 0;
  for (let n = 1; n <= wrongSubmits; n++) s += penaltyForNthWrongSubmit(n);
  return s;
};

/**
 * 조정 완주 시각 = (제출 통과 시각 − 판 시작 시각) + 오답 제출 페널티 합
 * **판 시작 기준 경과 초다** (D8). 절대 시각이 아니다.
 */
export const adjustedFinishSec = (passElapsedSec: number, wrongSubmits: number): number =>
  passElapsedSec + totalPenaltySec(wrongSubmits);

export interface Judgeable {
  accountId: string;
  finished: boolean;
  /** 완주자만 값을 갖는다 */
  adjustedFinishSec: number | null;
  correctCells: number;
  wrongSubmits: number;
  hintsUsed: number;
}
export interface Judged extends Judgeable { rank: number; rankPoint: number }

/** §4.1 정렬 키 — 앞선 키에서 갈리면 뒤는 보지 않는다 */
export function compareForRank(a: Judgeable, b: Judgeable): number {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;                       // 1
  if (a.finished && b.finished) {
    const d = (a.adjustedFinishSec ?? 0) - (b.adjustedFinishSec ?? 0);             // 2
    if (d !== 0) return d;
  } else {
    if (a.correctCells !== b.correctCells) return b.correctCells - a.correctCells; // 3
    if (a.wrongSubmits !== b.wrongSubmits) return a.wrongSubmits - b.wrongSubmits; // 4
  }
  if (a.hintsUsed !== b.hintsUsed) return a.hintsUsed - b.hintsUsed;               // 5
  return 0;                                                                        // 6 공동 순위
}

/** rankPoint = round(100 × (N − rank) / (N − 1)) — 인원수로 정규화 (§4.2) */
export const rankPoint = (rank: number, n: number): number =>
  n < 2 ? 0 : Math.round((100 * (n - rank)) / (n - 1));

/** 공동 순위는 같은 순위를 주고 다음 순위를 건너뛴다 (1위, 1위, 3위) */
export function judge(participants: Judgeable[]): Judged[] {
  const sorted = [...participants].sort(compareForRank);
  const n = sorted.length;
  const out: Judged[] = [];
  let rank = 0;
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (i === 0 || compareForRank(sorted[i - 1]!, cur) !== 0) rank = i + 1;
    out.push({ ...cur, rank, rankPoint: rankPoint(rank, n) });
  }
  return out;
}

/**
 * 팀 포인트 (§7.2 · D7)
 * 완주 구간의 하한 51은 페널티가 조정 완주 시각을 제한 시간 밖으로 밀어도
 * 완주가 미완주 아래로 내려가지 않게 한다.
 */
export function teamPoint(args: {
  finished: boolean; adjustedFinishSec: number | null; limitSec: number;
  correctCells: number; blankCells: number;
}): number {
  if (args.finished) {
    const adj = args.adjustedFinishSec ?? args.limitSec;
    return Math.max(51, 50 + Math.round((50 * (args.limitSec - adj)) / args.limitSec));
  }
  if (args.blankCells <= 0) return 0;
  return Math.round((50 * args.correctCells) / args.blankCells);
}

/** 무임승차 게이트 (D3) — 균등 분배 몫의 3분의 1, 또는 최소 5칸 중 큰 쪽 */
export const requiredContribution = (teamFilledCells: number, startingMembers: number): number =>
  Math.max(5, Math.floor(teamFilledCells / Math.max(1, startingMembers) / 3));

export const gatePassed = (contribution: number, teamFilledCells: number, startingMembers: number): boolean =>
  contribution >= requiredContribution(teamFilledCells, startingMembers);
