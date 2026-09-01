/** 룸 채팅 (FTR-CHAT) — 토큰 버킷 버스트 5건, 초당 1건 회복 (C4) */
export const CHAT_BURST = 5;
export const CHAT_REFILL_PER_SEC = 1;
export const CHAT_MAX_LEN = 200;

export class TokenBucket {
  private tokens = CHAT_BURST;
  private lastMs = Date.now();
  take(now = Date.now()): boolean {
    this.tokens = Math.min(CHAT_BURST, this.tokens + ((now - this.lastMs) / 1000) * CHAT_REFILL_PER_SEC);
    this.lastMs = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** 개방 범위 (C1) — 레이스 랭크 판만 진행 구간을 닫는다 */
export function chatOpen(args: { mode: 'race' | 'coop'; rankEligible: boolean; phase: 'waiting' | 'playing' | 'result' }): boolean {
  if (args.phase !== 'playing') return true;
  if (args.mode === 'coop') return true;
  return !args.rankEligible;
}
