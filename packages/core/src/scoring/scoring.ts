/**
 * 승부 판정과 점수 (DSN-SCORING)
 *
 * 판정은 순서로, 누적은 포인트로 분리한다 — 후보 C 하이브리드(D1).
 */
export const SUBMIT_LIMIT = 5;
export const HINT_LIMIT = 3;

/**
 * 조정 완주 시각 = 제출 통과 시각 − 판 시작 시각. **판 시작 기준 경과 초다** (D8).
 *
 * 이름의 "조정"은 오답 제출 페널티(D6)를 가리켰는데, **그 조정분은 항상 0이다** —
 * 게이트를 통과한 보드는 필연적으로 정답이라 오답 제출이 일어나지 않는다(D10 · N6).
 * 값이 달라지지 않는 개명에 문서 다섯 편과 저장 스키마를 움직이지 않기로 했다
 * (DSN-SCORING §4.1.2).
 */
export const adjustedFinishSec = (passElapsedSec: number): number => passElapsedSec;

export interface Judgeable {
  accountId: string;
  finished: boolean;
  /** 완주자만 값을 갖는다 */
  adjustedFinishSec: number | null;
  correctCells: number;
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
    // 4번 키(오답 제출 횟수)는 폐기됐다 — 항상 전원 0이다 (D10). 번호는 비워 둔다.
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
