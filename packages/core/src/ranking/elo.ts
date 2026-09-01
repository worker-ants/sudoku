/**
 * 레이팅 — Elo pairwise (DSN-RANKING §3 · R2)
 * **레이스 전용.** 협동에는 이길 상대가 없어 적용하지 않는다(§7.3).
 * 브래킷으로 나누지 않는다 — 사람당 레이팅 한 벌이다(R6).
 */
export const INITIAL_RATING = 1200;
export const PLACEMENT_MATCHES = 5;
export const K_PLACEMENT = 48;
export const K_NORMAL = 20;
export const REPEAT_OPPONENT_THRESHOLD = 3; // 24시간 내 같은 상대 3번째 판부터 K 절반

export interface RatingPlayer {
  accountId: string;
  rating: number;
  /** 배치 완료 전에는 보드에 노출하지 않는다 */
  rankedMatches: number;
  rank: number;
}
export interface EloOptions {
  /** 24시간 롤링 창 안에서 이 사람과 저 사람이 몇 번째 판인가 */
  recentPairCount?: (a: string, b: string) => number;
}

export const expectedScore = (mine: number, theirs: number): number =>
  1 / (1 + 10 ** ((theirs - mine) / 400));

export const kFactorFor = (p: RatingPlayer): number =>
  p.rankedMatches < PLACEMENT_MATCHES ? K_PLACEMENT : K_NORMAL;

/**
 * 모든 쌍(N(N−1)/2)에 대해 개별 대결로 계산하고 변동분을 합산한 뒤 (N−1)로 나눈다.
 * 나누지 않으면 8인 방 한 판이 2인 방 일곱 판만큼 흔들려, 큰 방만 도는 전략이 생긴다.
 */
export function computeEloDeltas(players: RatingPlayer[], opts: EloOptions = {}): Map<string, number> {
  const n = players.length;
  const out = new Map<string, number>();
  if (n < 2) { for (const p of players) out.set(p.accountId, 0); return out; }

  const raw = new Map<string, number>(players.map((p) => [p.accountId, 0]));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = players[i]!, b = players[j]!;
      const actualA = a.rank === b.rank ? 0.5 : a.rank < b.rank ? 1 : 0;
      const eA = expectedScore(a.rating, b.rating);
      let kA = kFactorFor(a), kB = kFactorFor(b);
      const repeats = opts.recentPairCount?.(a.accountId, b.accountId) ?? 0;
      if (repeats + 1 >= REPEAT_OPPONENT_THRESHOLD) { kA /= 2; kB /= 2; }
      raw.set(a.accountId, raw.get(a.accountId)! + kA * (actualA - eA));
      raw.set(b.accountId, raw.get(b.accountId)! + kB * (1 - actualA - (1 - eA)));
    }
  }
  for (const p of players) out.set(p.accountId, Math.round(raw.get(p.accountId)! / (n - 1)));
  return out;
}

export const isPlaced = (p: { rankedMatches: number }): boolean => p.rankedMatches >= PLACEMENT_MATCHES;
