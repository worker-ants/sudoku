/**
 * 영구 저장소 — PostgreSQL (ADR-STACK S2).
 *
 * SQL 은 한 벌이고 붙는 서버만 두 가지다 — 드라이버 선택은 sql.driver.ts 가 한다.
 * 어느 쪽이든 진짜 Postgres 이므로, 룰 스냅샷을 JSONB 로 두고 브래킷 재계산의 근거로
 * 삼는다는 §6.2의 결정이 실제로 성립하는지가 여기서 그대로 확인된다.
 */
import { PLACEMENT_MATCHES } from '@sudoku/core';
import { PgliteDriver, type SqlDriver } from './sql.driver.js';
import type {
  AccountRow, InputSummaryRow, MatchResultRow, PuzzleRow, PuzzleSeenRow,
  RatingRow, RecordRow, ResultStore, SeasonPointRow,
} from './ports.js';

export class SqlResultStore implements ResultStore {
  constructor(private readonly db: SqlDriver) {}

  async init(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS account (
        account_id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
        nickname TEXT NOT NULL, nickname_lower TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, created_at BIGINT NOT NULL,
        nickname_changed_season INT
      );
      CREATE TABLE IF NOT EXISTS match_result (
        match_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, puzzle_id TEXT NOT NULL,
        mode TEXT NOT NULL, difficulty TEXT NOT NULL, limit_sec INT NOT NULL,
        rank_eligible BOOLEAN NOT NULL, end_reason TEXT NOT NULL,
        started_at BIGINT NOT NULL, ended_at BIGINT NOT NULL,
        rules_snapshot JSONB NOT NULL, participants JSONB NOT NULL, team JSONB
      );
      CREATE TABLE IF NOT EXISTS rating (
        account_id TEXT PRIMARY KEY, rating INT NOT NULL,
        ranked_matches INT NOT NULL, updated_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_pair (
        match_id TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS season_point (
        account_id TEXT NOT NULL, season INT NOT NULL, match_id TEXT NOT NULL,
        points INT NOT NULL, at BIGINT NOT NULL,
        PRIMARY KEY (account_id, match_id)
      );
      -- 엔트리 단위가 모드마다 다르다(R9): 레이스는 참가자별 한 줄, 협동은 판 하나가 한 줄.
      -- 그래서 키에 holder_key 가 들어간다 — 레이스는 계정 ID, 협동은 빈 문자열이다.
      CREATE TABLE IF NOT EXISTS record_entry (
        bracket TEXT NOT NULL, match_id TEXT NOT NULL, holder_key TEXT NOT NULL,
        puzzle_id TEXT NOT NULL,
        adjusted_finish_sec INT NOT NULL, at BIGINT NOT NULL,
        holders JSONB NOT NULL, mode TEXT NOT NULL,
        PRIMARY KEY (bracket, match_id, holder_key)
      );
      CREATE TABLE IF NOT EXISTS puzzle (
        puzzle_id TEXT PRIMARY KEY, difficulty TEXT NOT NULL, seed BIGINT NOT NULL,
        givens JSONB NOT NULL, solution JSONB NOT NULL, path JSONB NOT NULL,
        clues INT NOT NULL, created_at BIGINT NOT NULL, taken BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS puzzle_seen (
        account_id TEXT NOT NULL, puzzle_id TEXT NOT NULL, at BIGINT NOT NULL,
        PRIMARY KEY (account_id, puzzle_id)
      );
      CREATE TABLE IF NOT EXISTS input_summary (
        match_id TEXT NOT NULL, account_id TEXT NOT NULL, inputs INT NOT NULL,
        median_gap_ms INT NOT NULL, variance_ms2 DOUBLE PRECISION NOT NULL,
        min_gap_ms INT NOT NULL, p5_gap_ms INT NOT NULL,
        PRIMARY KEY (match_id, account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_puzzle_pool ON puzzle (difficulty, taken);
      CREATE INDEX IF NOT EXISTS idx_record_bracket ON record_entry (bracket, adjusted_finish_sec);
    `);
  }

  private rows<T>(r: { rows: unknown[] }): T[] { return r.rows as T[]; }

  async createAccount(a: AccountRow): Promise<void> {
    await this.db.query(
      `INSERT INTO account (account_id,email,nickname,nickname_lower,password_hash,created_at,nickname_changed_season)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [a.accountId, a.email.toLowerCase(), a.nickname, a.nickname.toLowerCase().replace(/\s+/g, ''), a.passwordHash, a.createdAtEpochMs, a.nicknameChangedSeason],
    );
  }
  private mapAccount(r: Record<string, unknown>): AccountRow {
    return {
      accountId: r['account_id'] as string, email: r['email'] as string,
      nickname: r['nickname'] as string, passwordHash: r['password_hash'] as string,
      createdAtEpochMs: Number(r['created_at']), nicknameChangedSeason: r['nickname_changed_season'] as number | null,
    };
  }
  async findAccountByEmail(email: string): Promise<AccountRow | null> {
    const r = this.rows<Record<string, unknown>>(await this.db.query('SELECT * FROM account WHERE email=$1', [email.toLowerCase()]));
    return r[0] ? this.mapAccount(r[0]) : null;
  }
  async findAccountByNickname(nickname: string): Promise<AccountRow | null> {
    const r = this.rows<Record<string, unknown>>(await this.db.query('SELECT * FROM account WHERE nickname_lower=$1', [nickname.toLowerCase().replace(/\s+/g, '')]));
    return r[0] ? this.mapAccount(r[0]) : null;
  }
  /** 닉네임과 "바꾼 시즌" 은 한 문장으로 굳는다 — 따로 쓰면 시즌 제한이 새는 창이 생긴다 */
  async updateNickname(accountId: string, nickname: string, season: number): Promise<void> {
    await this.db.query(
      'UPDATE account SET nickname=$2, nickname_lower=$3, nickname_changed_season=$4 WHERE account_id=$1',
      [accountId, nickname, nickname.toLowerCase().replace(/\s+/g, ''), season],
    );
  }
  async findAccountById(accountId: string): Promise<AccountRow | null> {
    const r = this.rows<Record<string, unknown>>(await this.db.query('SELECT * FROM account WHERE account_id=$1', [accountId]));
    return r[0] ? this.mapAccount(r[0]) : null;
  }

  async saveMatchResult(m: MatchResultRow): Promise<{ inserted: boolean }> {
    const r = await this.db.query(
      `INSERT INTO match_result (match_id,room_id,puzzle_id,mode,difficulty,limit_sec,rank_eligible,end_reason,started_at,ended_at,rules_snapshot,participants,team)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (match_id) DO NOTHING RETURNING match_id`,
      [m.matchId, m.roomId, m.puzzleId, m.mode, m.difficulty, m.limitSec, m.rankEligible, m.endReason,
       m.startedAtEpochMs, m.endedAtEpochMs, JSON.stringify(m.rulesSnapshot), JSON.stringify(m.participants), JSON.stringify(m.team ?? null)],
    );
    return { inserted: r.rows.length > 0 };
  }
  async hasMatchResult(matchId: string): Promise<boolean> {
    return this.rows(await this.db.query('SELECT 1 FROM match_result WHERE match_id=$1', [matchId])).length > 0;
  }
  async listMatchResults(accountId: string, limit = 20): Promise<MatchResultRow[]> {
    const r = this.rows<Record<string, unknown>>(await this.db.query(
      `SELECT * FROM match_result WHERE participants @> $1::jsonb ORDER BY ended_at DESC LIMIT $2`,
      [JSON.stringify([{ accountId }]), limit],
    ));
    return r.map((x) => ({
      matchId: x['match_id'] as string, roomId: x['room_id'] as string, puzzleId: x['puzzle_id'] as string,
      mode: x['mode'] as string, difficulty: x['difficulty'] as string, limitSec: Number(x['limit_sec']),
      rankEligible: x['rank_eligible'] as boolean, endReason: x['end_reason'] as string,
      startedAtEpochMs: Number(x['started_at']), endedAtEpochMs: Number(x['ended_at']),
      rulesSnapshot: x['rules_snapshot'], participants: x['participants'], team: x['team'],
    }));
  }

  async getRating(accountId: string): Promise<RatingRow | null> {
    const r = this.rows<Record<string, unknown>>(await this.db.query('SELECT * FROM rating WHERE account_id=$1', [accountId]));
    if (!r[0]) return null;
    return { accountId, rating: Number(r[0]['rating']), rankedMatches: Number(r[0]['ranked_matches']), updatedAtEpochMs: Number(r[0]['updated_at']) };
  }
  async upsertRating(row: RatingRow): Promise<void> {
    await this.db.query(
      `INSERT INTO rating (account_id,rating,ranked_matches,updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (account_id) DO UPDATE SET rating=$2, ranked_matches=$3, updated_at=$4`,
      [row.accountId, row.rating, row.rankedMatches, row.updatedAtEpochMs],
    );
  }
  async topRatings(limit: number): Promise<(RatingRow & { nickname: string })[]> {
    const r = this.rows<Record<string, unknown>>(await this.db.query(
      `SELECT r.*, a.nickname FROM rating r JOIN account a ON a.account_id=r.account_id
       WHERE r.ranked_matches >= $2 ORDER BY r.rating DESC LIMIT $1`, [limit, PLACEMENT_MATCHES]));
    return r.map((x) => ({
      accountId: x['account_id'] as string, rating: Number(x['rating']),
      rankedMatches: Number(x['ranked_matches']), updatedAtEpochMs: Number(x['updated_at']),
      nickname: x['nickname'] as string,
    }));
  }
  async countRecentPairMatches(a: string, b: string, since: number): Promise<number> {
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.rows(await this.db.query('SELECT 1 FROM match_pair WHERE a=$1 AND b=$2 AND at > $3', [x, y, since])).length;
  }
  async recordPairs(matchId: string, ids: string[], at: number): Promise<void> {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const [x, y] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
      await this.db.query('INSERT INTO match_pair (match_id,a,b,at) VALUES ($1,$2,$3,$4)', [matchId, x, y, at]);
    }
  }

  async addSeasonPoints(rows: SeasonPointRow[]): Promise<void> {
    for (const r of rows) {
      await this.db.query(
        `INSERT INTO season_point (account_id,season,match_id,points,at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (account_id, match_id) DO NOTHING`,
        [r.accountId, r.season, r.matchId, r.points, r.atEpochMs]);
    }
  }
  async seasonLeaderboard(season: number, limit: number): Promise<{ accountId: string; nickname: string; points: number }[]> {
    const r = this.rows<Record<string, unknown>>(await this.db.query(
      `SELECT s.account_id, a.nickname, SUM(s.points)::int AS points
       FROM season_point s JOIN account a ON a.account_id=s.account_id
       WHERE s.season=$1 GROUP BY s.account_id, a.nickname ORDER BY points DESC LIMIT $2`, [season, limit]));
    return r.map((x) => ({ accountId: x['account_id'] as string, nickname: x['nickname'] as string, points: Number(x['points']) }));
  }

  async addRecords(rows: RecordRow[]): Promise<void> {
    for (const r of rows) {
      const holders = r.holders as { accountId: string }[];
      const holderKey = r.mode === 'race' ? (holders[0]?.accountId ?? '') : '';
      await this.db.query(
        `INSERT INTO record_entry (bracket,match_id,holder_key,puzzle_id,adjusted_finish_sec,at,holders,mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (bracket, match_id, holder_key) DO NOTHING`,
        [r.bracket, r.matchId, holderKey, r.puzzleId, r.adjustedFinishSec, r.atEpochMs, JSON.stringify(r.holders), r.mode]);
    }
  }
  async topRecords(bracket: string, limit: number): Promise<RecordRow[]> {
    const r = this.rows<Record<string, unknown>>(await this.db.query(
      `SELECT * FROM record_entry WHERE bracket=$1 ORDER BY adjusted_finish_sec ASC, at ASC LIMIT $2`, [bracket, limit]));
    return r.map((x) => ({
      bracket: x['bracket'] as string, matchId: x['match_id'] as string, puzzleId: x['puzzle_id'] as string,
      adjustedFinishSec: Number(x['adjusted_finish_sec']), atEpochMs: Number(x['at']),
      holders: x['holders'], mode: x['mode'] as string,
    }));
  }

  async addPuzzle(p: PuzzleRow): Promise<void> {
    await this.db.query(
      `INSERT INTO puzzle (puzzle_id,difficulty,seed,givens,solution,path,clues,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (puzzle_id) DO NOTHING`,
      [p.puzzleId, p.difficulty, p.seed, JSON.stringify(p.givens), JSON.stringify(p.solution), JSON.stringify(p.path), p.clues, p.createdAtEpochMs]);
  }
  async countAvailablePuzzles(difficulty: string, excludeIds: string[]): Promise<number> {
    const r = this.rows<Record<string, unknown>>(await this.db.query(
      `SELECT COUNT(*)::int AS n FROM puzzle
       WHERE difficulty=$1 AND taken=FALSE AND NOT (puzzle_id = ANY($2::text[]))`,
      [difficulty, excludeIds]));
    return Number(r[0]?.['n'] ?? 0);
  }
  async countPuzzles(difficulty: string): Promise<number> {
    const r = this.rows<Record<string, unknown>>(await this.db.query(
      'SELECT COUNT(*)::int AS n FROM puzzle WHERE difficulty=$1 AND taken=FALSE', [difficulty]));
    return Number(r[0]?.['n'] ?? 0);
  }
  async takePuzzle(difficulty: string, excludeIds: string[]): Promise<PuzzleRow | null> {
    const r = this.rows<Record<string, unknown>>(await this.db.query(
      `SELECT * FROM puzzle WHERE difficulty=$1 AND taken=FALSE AND NOT (puzzle_id = ANY($2::text[]))
       ORDER BY created_at ASC LIMIT 1`, [difficulty, excludeIds]));
    if (!r[0]) return null;
    const id = r[0]['puzzle_id'] as string;
    await this.db.query('UPDATE puzzle SET taken=TRUE WHERE puzzle_id=$1', [id]);
    return {
      puzzleId: id, difficulty, seed: Number(r[0]['seed']),
      givens: r[0]['givens'] as number[], solution: r[0]['solution'] as number[],
      path: r[0]['path'], clues: Number(r[0]['clues']), createdAtEpochMs: Number(r[0]['created_at']),
    };
  }
  async untakePuzzle(puzzleId: string): Promise<void> {
    await this.db.query('UPDATE puzzle SET taken=FALSE WHERE puzzle_id=$1', [puzzleId]);
  }
  async markPuzzleSeen(rows: PuzzleSeenRow[]): Promise<void> {
    for (const r of rows) {
      await this.db.query(
        'INSERT INTO puzzle_seen (account_id,puzzle_id,at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [r.accountId, r.puzzleId, r.atEpochMs]);
    }
  }
  async puzzlesSeenSince(accountIds: string[], since: number): Promise<string[]> {
    if (accountIds.length === 0) return [];
    const r = this.rows<Record<string, unknown>>(await this.db.query(
      'SELECT DISTINCT puzzle_id FROM puzzle_seen WHERE account_id = ANY($1::text[]) AND at > $2',
      [accountIds, since]));
    return r.map((x) => x['puzzle_id'] as string);
  }

  async addInputSummaries(rows: InputSummaryRow[]): Promise<void> {
    for (const r of rows) {
      await this.db.query(
        `INSERT INTO input_summary (match_id,account_id,inputs,median_gap_ms,variance_ms2,min_gap_ms,p5_gap_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (match_id, account_id) DO NOTHING`,
        [r.matchId, r.accountId, r.inputs, r.medianGapMs, r.varianceMs2, r.minGapMs, r.p5GapMs]);
    }
  }
  async close(): Promise<void> { await this.db.close(); }
}

/** 인프로세스 PGlite 로 도는 스토어 — 단위 테스트와 오프라인 실행용 지름길. */
export class PgliteResultStore extends SqlResultStore {
  constructor(dataDir?: string) { super(new PgliteDriver(dataDir)); }
}
