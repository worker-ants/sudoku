/**
 * 랭크 자격 조건 (DSN-RANKING §2.5 · §2.5.2)
 *
 * 하나라도 어긋나면 캐주얼 판이 되어 **개인 전적에는 남지만 세 랭킹 어디에도 반영되지 않는다.**
 * 어긋난 항목은 이름으로 돌려준다 — 호스트가 무엇을 되돌려야 할지 알아야 한다(AREA-ROOM §7).
 */
import { STANDARD_LIMIT_SEC, type Rules } from './rules.js';

export interface EligibilityInput {
  rules: Rules;
  /** 실제 참가 인원. 정원이 아니라 이 값이 걸린다 */
  memberCount: number;
  /**
   * 퍼즐 배정 가능 여부 (R8). 재배정 금지 30일을 지켜 배정할 수 있는가.
   * **시작 순간에만 알 수 있으므로** 룸 화면의 실시간 표시에서는 undefined 로 둔다 —
   * 그 자리에서는 이 항목을 평가하지 않고, 시작 조건 5가 대신 막는다.
   */
  puzzleAssignable?: boolean;
}
export interface Eligibility { eligible: boolean; reasons: string[] }

export const MIN_PLAYERS = { race: 3, coop: 2 } as const;

export function evaluateEligibility({ rules, memberCount, puzzleAssignable }: EligibilityInput): Eligibility {
  const reasons: string[] = [];
  const standard = STANDARD_LIMIT_SEC[rules.difficulty];

  if (rules.hintsAllowed) reasons.push('힌트 허용');
  if (rules.violationDisplay !== 'show') reasons.push('제약 위반 표시 — 숨김');
  if (rules.limitSec !== standard)
    reasons.push(`제한 시간 ${Math.round(rules.limitSec / 60)}분 (표준 ${Math.round(standard / 60)}분)`);

  const min = MIN_PLAYERS[rules.mode];
  if (memberCount < min)
    reasons.push(`참가 인원 ${memberCount}명 (${rules.mode === 'race' ? '레이스' : '협동'} 랭크 최소 ${min}명)`);

  if (puzzleAssignable === false)
    reasons.push('배정 가능한 퍼즐 없음 — 최근 30일 재배정 금지');

  return { eligible: reasons.length === 0, reasons };
}
