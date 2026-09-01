import { describe, it, expect } from 'vitest';
import { INITIAL_RATING, K_NORMAL, K_PLACEMENT, computeEloDeltas, expectedScore, kFactorFor } from '../src/ranking/elo.js';
import { DAILY_MATCH_CAP, applyDailyCap, seasonContribution, weightForPlayers } from '../src/ranking/season.js';
import { ALL_BRACKETS, bracketKey, buildRecordEntries, sizeBandOf, topRecords } from '../src/ranking/records.js';
import { utcDayKey, seasonIndex, withinRolling, ROLLING_24H } from '../src/time/window.js';

describe('레이팅 — Elo pairwise (R2)', () => {
  it('같은 레이팅이면 기대값 0.5', () => expect(expectedScore(1200, 1200)).toBeCloseTo(0.5));
  it('배치 5판까지 K=48, 이후 20', () => {
    expect(kFactorFor({ accountId: 'a', rating: 1200, rankedMatches: 0, rank: 1 })).toBe(K_PLACEMENT);
    expect(kFactorFor({ accountId: 'a', rating: 1200, rankedMatches: 5, rank: 1 })).toBe(K_NORMAL);
  });
  it('N−1 로 나눈다 — 큰 방 한 판이 작은 방 여러 판을 이기지 않는다', () => {
    const two = computeEloDeltas([
      { accountId: 'a', rating: 1200, rankedMatches: 10, rank: 1 },
      { accountId: 'b', rating: 1200, rankedMatches: 10, rank: 2 },
    ]);
    const eight = computeEloDeltas(Array.from({ length: 8 }, (_, i) => ({
      accountId: `p${i}`, rating: 1200, rankedMatches: 10, rank: i + 1,
    })));
    expect(two.get('a')).toBe(10);            // 20 × 0.5
    expect(eight.get('p0')).toBeLessThanOrEqual(12);   // 8인 방 1위도 비슷한 크기
  });
  it('전원 무승부면 변동이 0', () => {
    const d = computeEloDeltas([
      { accountId: 'a', rating: 1200, rankedMatches: 10, rank: 1 },
      { accountId: 'b', rating: 1200, rankedMatches: 10, rank: 1 },
    ]);
    expect(d.get('a')).toBe(0); expect(d.get('b')).toBe(0);
  });
  it('합이 0에 가깝다 — 제로섬', () => {
    const d = computeEloDeltas(Array.from({ length: 4 }, (_, i) => ({
      accountId: `p${i}`, rating: 1200 + i * 50, rankedMatches: 10, rank: i + 1,
    })));
    const sum = [...d.values()].reduce((a, b) => a + b, 0);
    expect(Math.abs(sum)).toBeLessThanOrEqual(2);
  });
  it('24시간 내 같은 상대 3번째 판부터 K 절반', () => {
    const plain = computeEloDeltas([
      { accountId: 'a', rating: 1200, rankedMatches: 10, rank: 1 },
      { accountId: 'b', rating: 1200, rankedMatches: 10, rank: 2 },
    ]);
    const halved = computeEloDeltas([
      { accountId: 'a', rating: 1200, rankedMatches: 10, rank: 1 },
      { accountId: 'b', rating: 1200, rankedMatches: 10, rank: 2 },
    ], { recentPairCount: () => 2 });
    expect(halved.get('a')).toBe(Math.round(plain.get('a')! / 2));
  });
  it('초기 레이팅은 1200', () => expect(INITIAL_RATING).toBe(1200));
});

describe('시즌 포인트 (R3 · R7)', () => {
  it('weight(N) = min(1, 0.5 + 0.1N)', () => {
    expect(weightForPlayers(2)).toBeCloseTo(0.7);
    expect(weightForPlayers(4)).toBeCloseTo(0.9);
    expect(weightForPlayers(5)).toBe(1);
    expect(weightForPlayers(8)).toBe(1);
  });
  it('teamPoint 에는 가중치가 붙지 않는다 (R7)', () => {
    expect(seasonContribution({ teamPoint: 80, playerCount: 2 })).toBe(80);
    expect(seasonContribution({ teamPoint: 80, playerCount: 8 })).toBe(80);
  });
  it('rankPoint 에만 붙는다', () => {
    expect(seasonContribution({ rankPoint: 100, playerCount: 2 })).toBe(70);
    expect(seasonContribution({ rankPoint: 100, playerCount: 5 })).toBe(100);
  });
  it('일일 상한 20판 — 하루의 상위 20판만 집계', () => {
    const day = Date.UTC(2026, 0, 2, 5);
    const entries = Array.from({ length: 30 }, (_, i) => ({ atEpochMs: day, points: i + 1 }));
    // 상위 20개 = 11..30 의 합
    expect(applyDailyCap(entries)).toBe(410);
    expect(DAILY_MATCH_CAP).toBe(20);
  });
  it('하루 경계는 UTC 자정이다 (R10)', () => {
    const a = Date.UTC(2026, 0, 1, 23, 59);
    const b = Date.UTC(2026, 0, 2, 0, 1);
    expect(utcDayKey(a)).not.toBe(utcDayKey(b));
    const entries = [...Array.from({ length: 25 }, () => ({ atEpochMs: a, points: 10 })),
                     ...Array.from({ length: 25 }, () => ({ atEpochMs: b, points: 10 }))];
    expect(applyDailyCap(entries)).toBe(20 * 10 * 2);   // 이틀치니까 각각 20판씩
  });
  it('시즌은 4주 고정 주기', () => {
    const cfg = { epochMs: Date.UTC(2026, 0, 1) };
    expect(seasonIndex(Date.UTC(2026, 0, 1), cfg)).toBe(0);
    expect(seasonIndex(Date.UTC(2026, 0, 29), cfg)).toBe(1);
  });
  it('롤링 창은 지금으로부터 거꾸로 센다', () => {
    const now = Date.UTC(2026, 0, 10);
    expect(withinRolling(now - 1000, now, ROLLING_24H)).toBe(true);
    expect(withinRolling(now - ROLLING_24H - 1, now, ROLLING_24H)).toBe(false);
  });
});

describe('기록 랭킹 (R6 · R9)', () => {
  it('기록 축의 보드는 20개 — 레이스 5 + 협동 5×3', () => {
    expect(ALL_BRACKETS).toHaveLength(20);
  });
  it('인원 구간', () => {
    expect(sizeBandOf(2)).toBe('2');
    expect(sizeBandOf(4)).toBe('3-4');
    expect(sizeBandOf(5)).toBe('5+');
    expect(bracketKey('coop', 'hard', 6)).toBe('coop:hard:5+');
  });
  it('레이스는 참가자 한 명이 한 줄', () => {
    const e = buildRecordEntries({
      mode: 'race', difficulty: 'normal', matchId: 'm1', puzzleId: 'p1', atEpochMs: 1, startingMembers: 3,
      race: [
        { accountId: 'a', nickname: 'A', finished: true, adjustedFinishSec: 400 },
        { accountId: 'b', nickname: 'B', finished: true, adjustedFinishSec: 500 },
        { accountId: 'c', nickname: 'C', finished: false, adjustedFinishSec: null },
      ],
    });
    expect(e).toHaveLength(2);
    expect(e[0]!.holders).toHaveLength(1);
  });
  it('협동은 판 하나가 한 줄이고 이름 자리에 게이트 통과자 명단이 들어간다 (R9)', () => {
    const e = buildRecordEntries({
      mode: 'coop', difficulty: 'hard', matchId: 'm2', puzzleId: 'p2', atEpochMs: 1, startingMembers: 5,
      coop: { finished: true, adjustedFinishSec: 900, passers: [
        { accountId: 'a', nickname: 'A' }, { accountId: 'b', nickname: 'B' }, { accountId: 'c', nickname: 'C' },
      ] },
    });
    expect(e).toHaveLength(1);                       // 5인 팀이 다섯 줄을 차지하지 않는다
    expect(e[0]!.holders).toHaveLength(3);
    expect(e[0]!.bracket).toBe('coop:hard:5+');
  });
  it('미완주는 기록을 남기지 않는다', () => {
    expect(buildRecordEntries({
      mode: 'coop', difficulty: 'hard', matchId: 'm3', puzzleId: 'p3', atEpochMs: 1, startingMembers: 2,
      coop: { finished: false, adjustedFinishSec: null, passers: [] },
    })).toHaveLength(0);
  });
  it('브래킷별 최소값 순으로 정렬한다', () => {
    const mk = (s: number, id: string) => ({ bracket: 'race:normal', matchId: id, puzzleId: 'p', adjustedFinishSec: s, atEpochMs: 1, holders: [], mode: 'race' as const });
    expect(topRecords([mk(500, 'x'), mk(300, 'y'), mk(400, 'z')], 'race:normal').map((e) => e.matchId)).toEqual(['y', 'z', 'x']);
  });
});
