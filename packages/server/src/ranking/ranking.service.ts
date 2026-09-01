/**
 * 결과 확정과 랭킹 (AREA-RANK · DSN-RANKING)
 *
 * 게임플레이 영역이 원자료를 넘기면 여기서 순위·점수·랭킹이 정해진다.
 * **이관은 멱등하다** — 같은 판을 두 번 넣어도 랭킹이 두 번 오르지 않는다.
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  INITIAL_RATING, ROLLING_24H, buildRecordEntries, computeEloDeltas, seasonContribution,
  seasonIndex, teamPoint, type FinalizedMatch, type MatchState,
} from '@sudoku/core';
import { CONFIG } from '../config.js';
import type { InputSummaryRow, ResultStore } from '../storage/ports.js';

@Injectable()
export class RankingService {
  private readonly log = new Logger('Ranking');
  constructor(@Inject('ResultStore') private readonly db: ResultStore) {}

  async handoff(m: MatchState, f: FinalizedMatch & { inputSummaries?: InputSummaryRow[] }): Promise<{ ratingDeltas: Map<string, number> }> {
    const endedAt = m.finalizedAtEpochMs ?? Date.now();
    const ratingDeltas = new Map<string, number>();

    const { inserted } = await this.db.saveMatchResult({
      matchId: m.matchId, roomId: m.roomId, puzzleId: m.puzzleId,
      mode: m.mode, difficulty: m.difficulty, limitSec: m.limitSec,
      rankEligible: m.rankEligible, endReason: f.endReason,
      startedAtEpochMs: m.startedAtEpochMs, endedAtEpochMs: endedAt,
      rulesSnapshot: {
        mode: m.mode, difficulty: m.difficulty, limitSec: m.limitSec,
        violationDisplay: m.violationDisplay, hintsAllowed: m.hintsAllowed,
        capacity: m.startingMembers.length, startingMembers: m.startingMembers,
        rankEligible: m.rankEligible,
      },
      participants: f.participants.map((p) => ({ ...p, cells: undefined })),
      team: f.team ?? null,
    });

    if (f.inputSummaries?.length) await this.db.addInputSummaries(f.inputSummaries);
    await this.db.markPuzzleSeen(m.startingMembers.map((accountId) => ({ accountId, puzzleId: m.puzzleId, atEpochMs: endedAt })));

    if (!inserted) { this.log.warn(`판 ${m.matchId} 은 이미 이관되어 있다 — 랭킹을 다시 올리지 않는다`); return { ratingDeltas }; }
    if (!m.rankEligible) return { ratingDeltas };

    const season = seasonIndex(endedAt, { epochMs: CONFIG.seasonEpochMs });
    const playerCount = f.participants.length;

    if (m.mode === 'race') {
      // 레이팅 — 레이스 전용, 통합 1벌(R6)
      const players = [];
      for (const p of f.participants) {
        const cur = (await this.db.getRating(p.accountId)) ?? { accountId: p.accountId, rating: INITIAL_RATING, rankedMatches: 0, updatedAtEpochMs: endedAt };
        players.push({ accountId: p.accountId, rating: cur.rating, rankedMatches: cur.rankedMatches, rank: p.rank });
      }
      const since = endedAt - ROLLING_24H;
      const pairCounts = new Map<string, number>();
      for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
        const a = players[i]!.accountId, b = players[j]!.accountId;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        pairCounts.set(key, await this.db.countRecentPairMatches(a, b, since));
      }
      const deltas = computeEloDeltas(players, {
        recentPairCount: (a, b) => pairCounts.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0,
      });
      for (const p of players) {
        const d = deltas.get(p.accountId) ?? 0;
        ratingDeltas.set(p.accountId, d);
        await this.db.upsertRating({ accountId: p.accountId, rating: p.rating + d, rankedMatches: p.rankedMatches + 1, updatedAtEpochMs: endedAt });
      }
      const anyDb = this.db as unknown as { recordPairs?: (id: string, ids: string[], at: number) => Promise<void> };
      await anyDb.recordPairs?.(m.matchId, players.map((p) => p.accountId), endedAt);

      await this.db.addSeasonPoints(f.participants.map((p) => ({
        accountId: p.accountId, season, matchId: m.matchId,
        points: seasonContribution({ rankPoint: p.rankPoint, playerCount }), atEpochMs: endedAt,
      })));
      await this.db.addRecords(buildRecordEntries({
        mode: 'race', difficulty: m.difficulty, matchId: m.matchId, puzzleId: m.puzzleId,
        atEpochMs: endedAt, startingMembers: m.startingMembers.length,
        race: f.participants.map((p) => ({ accountId: p.accountId, nickname: p.nickname, finished: p.finished, adjustedFinishSec: p.adjustedFinishSec })),
      }));
    } else {
      // 협동 — 레이팅 없음. 게이트를 통과한 사람만 랭킹에 반영된다
      const tp = f.team?.teamPoint ?? 0;
      const passers = f.participants.filter((p) => p.gatePassed);
      await this.db.addSeasonPoints(passers.map((p) => ({
        accountId: p.accountId, season, matchId: m.matchId,
        points: seasonContribution({ teamPoint: tp, playerCount }), atEpochMs: endedAt,
      })));
      await this.db.addRecords(buildRecordEntries({
        mode: 'coop', difficulty: m.difficulty, matchId: m.matchId, puzzleId: m.puzzleId,
        atEpochMs: endedAt, startingMembers: m.startingMembers.length,
        coop: {
          finished: f.team?.finished ?? false,
          adjustedFinishSec: f.team?.adjustedFinishSec ?? null,
          passers: passers.map((p) => ({ accountId: p.accountId, nickname: p.nickname })),
        },
      }));
      void teamPoint;
    }
    return { ratingDeltas };
  }

  async boards(season: number) {
    return {
      rating: await this.db.topRatings(100),
      season: await this.db.seasonLeaderboard(season, 100),
    };
  }
  async records(bracket: string) { return this.db.topRecords(bracket, 100); }
  async history(accountId: string) { return this.db.listMatchResults(accountId, 20); }
}
