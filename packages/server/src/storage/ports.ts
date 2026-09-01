/**
 * 저장소 포트 (ADR-STACK §6)
 *
 * 데이터가 두 종류라는 §6.1의 구분을 그대로 인터페이스로 만든다.
 *   StateStore  진행 중 상태 — 쓰기가 잦고 판이 끝나면 버려진다   (운영: Redis)
 *   ResultStore 영구·관계형 — 쓰기는 드물고 집계 쿼리가 많다      (운영: PostgreSQL)
 */
export interface StateStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  close(): Promise<void>;
}

export interface AccountRow {
  accountId: string; email: string; nickname: string; passwordHash: string;
  createdAtEpochMs: number; nicknameChangedSeason: number | null;
}
export interface MatchResultRow {
  matchId: string; roomId: string; puzzleId: string;
  mode: string; difficulty: string; limitSec: number;
  rankEligible: boolean; endReason: string;
  startedAtEpochMs: number; endedAtEpochMs: number;
  rulesSnapshot: unknown;      // JSONB — 브래킷 재계산의 근거
  participants: unknown;
  team: unknown;
}
export interface RatingRow { accountId: string; rating: number; rankedMatches: number; updatedAtEpochMs: number }
export interface SeasonPointRow { accountId: string; season: number; matchId: string; points: number; atEpochMs: number }
export interface RecordRow {
  bracket: string; matchId: string; puzzleId: string; adjustedFinishSec: number;
  atEpochMs: number; holders: unknown; mode: string;
}
export interface PuzzleRow {
  puzzleId: string; difficulty: string; seed: number;
  givens: number[]; solution: number[]; path: unknown; clues: number; createdAtEpochMs: number;
}
export interface PuzzleSeenRow { accountId: string; puzzleId: string; atEpochMs: number }
/** 봇 탐지용 입력 간격 요약 (ADR-STACK §6.2.1) — 원본 타임스탬프는 남기지 않는다 */
export interface InputSummaryRow {
  matchId: string; accountId: string; inputs: number;
  medianGapMs: number; varianceMs2: number; minGapMs: number; p5GapMs: number;
}

export interface ResultStore {
  init(): Promise<void>;
  createAccount(row: AccountRow): Promise<void>;
  findAccountByEmail(email: string): Promise<AccountRow | null>;
  findAccountByNickname(nickname: string): Promise<AccountRow | null>;
  findAccountById(accountId: string): Promise<AccountRow | null>;

  /** 판 종료 이관은 멱등하다 — 같은 matchId 를 두 번 넣어도 랭킹이 두 번 오르지 않는다 */
  saveMatchResult(row: MatchResultRow): Promise<{ inserted: boolean }>;
  hasMatchResult(matchId: string): Promise<boolean>;
  listMatchResults(accountId: string, limit?: number): Promise<MatchResultRow[]>;

  getRating(accountId: string): Promise<RatingRow | null>;
  upsertRating(row: RatingRow): Promise<void>;
  topRatings(limit: number): Promise<(RatingRow & { nickname: string })[]>;
  countRecentPairMatches(a: string, b: string, sinceEpochMs: number): Promise<number>;

  addSeasonPoints(rows: SeasonPointRow[]): Promise<void>;
  seasonLeaderboard(season: number, limit: number): Promise<{ accountId: string; nickname: string; points: number }[]>;

  addRecords(rows: RecordRow[]): Promise<void>;
  topRecords(bracket: string, limit: number): Promise<RecordRow[]>;

  addPuzzle(row: PuzzleRow): Promise<void>;
  countPuzzles(difficulty: string): Promise<number>;
  takePuzzle(difficulty: string, excludeIds: string[]): Promise<PuzzleRow | null>;
  markPuzzleSeen(rows: PuzzleSeenRow[]): Promise<void>;
  puzzlesSeenSince(accountIds: string[], sinceEpochMs: number): Promise<string[]>;

  addInputSummaries(rows: InputSummaryRow[]): Promise<void>;
  close(): Promise<void>;
}
