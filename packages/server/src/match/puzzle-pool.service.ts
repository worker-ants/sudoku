/**
 * 사전 생성 풀 + 실시간 폴백 (PUZZLE §5 · U2)
 *
 * 목표 등급의 폐기율이 등급마다 크게 다르므로(실측: 입문 1회 · 보통 17회 · 악몽 13회 시도)
 * 시작 시점에 생성을 돌리면 지연이 판마다 널뛴다. 배치 워커가 미리 만들어 둔다.
 *
 * **랭크 판은 폴백 배정으로 시작하지 않는다**(R8). 캐주얼만 폴백한다.
 */
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { ROLLING_30D, generatePuzzle, type Difficulty } from '@sudoku/core';
import { CONFIG } from '../config.js';
import type { PuzzleRow, ResultStore } from '../storage/ports.js';

const DIFFICULTIES: Difficulty[] = ['intro', 'normal', 'hard', 'expert', 'nightmare'];

export interface Assignment { puzzle: PuzzleRow; fallback: boolean }

@Injectable()
export class PuzzlePoolService implements OnModuleDestroy {
  private readonly log = new Logger('PuzzlePool');
  private timer: NodeJS.Timeout | null = null;
  private filling = false;

  constructor(@Inject('ResultStore') private readonly db: ResultStore) {}

  async topUp(minStock = CONFIG.poolMinStock): Promise<Record<string, number>> {
    if (this.filling) return {};
    this.filling = true;
    const made: Record<string, number> = {};
    try {
      for (const d of DIFFICULTIES) {
        let have = await this.db.countPuzzles(d);
        while (have < minStock) {
          const r = generatePuzzle(d, { maxAttempts: 400 });
          if (!r.puzzle) { this.log.warn(`${d} 생성 실패 — 다음 주기에 다시 시도한다`); break; }
          await this.db.addPuzzle({
            puzzleId: r.puzzle.puzzleId, difficulty: d, seed: r.puzzle.seed,
            givens: r.puzzle.givens, solution: r.puzzle.solution, path: r.puzzle.path,
            clues: r.puzzle.clues, createdAtEpochMs: r.puzzle.createdAtEpochMs,
          });
          made[d] = (made[d] ?? 0) + 1;
          have++;
        }
      }
    } finally { this.filling = false; }
    return made;
  }

  start(): void {
    if (this.timer) return;
    void this.topUp();
    this.timer = setInterval(() => { void this.topUp(); }, 15_000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  onModuleDestroy(): void { this.stop(); }

  /** 최근 30일(롤링) 안에 참가자 누구라도 본 퍼즐은 후보에서 뺀다 */
  private async excluded(accountIds: string[], now: number): Promise<string[]> {
    return this.db.puzzlesSeenSince(accountIds, now - ROLLING_30D);
  }

  /**
   * 시작 조건 5 — 랭크 판이 폴백 없이 배정될 수 있는가.
   *
   * **세기만 한다.** 이전 구현은 퍼즐을 꺼냈다가 되돌려 놓았는데, 그러면 질문에 답하는
   * 동안 풀에서 그 퍼즐이 사라진다. 룸 상태를 새로 그릴 때마다 불리는 함수라 호출이
   * 겹치기 쉽고, 겹치면 서로의 퍼즐을 뺏어 "새 퍼즐이 없습니다"가 헛나온다.
   */
  async canAssignWithoutFallback(difficulty: Difficulty, accountIds: string[], now = Date.now()): Promise<boolean> {
    const exclude = await this.excluded(accountIds, now);
    return (await this.db.countAvailablePuzzles(difficulty, exclude)) > 0;
  }

  /**
   * 배정. 랭크 판은 폴백을 허용하지 않는다.
   * 후보가 없으면 랭크는 null(시작 거부), 캐주얼은 제외 기간을 줄여 배정한다.
   */
  async assign(difficulty: Difficulty, accountIds: string[], rankEligible: boolean, now = Date.now()): Promise<Assignment | null> {
    const exclude = await this.excluded(accountIds, now);
    const first = await this.db.takePuzzle(difficulty, exclude);
    if (first) return { puzzle: first, fallback: false };
    if (rankEligible) return null;                       // R8 — 랭크는 여기서 멈춘다
    await this.topUp();
    const relaxed = await this.db.takePuzzle(difficulty, []);   // 제외 기간을 줄여 배정
    return relaxed ? { puzzle: relaxed, fallback: true } : null;
  }

  async markSeen(accountIds: string[], puzzleId: string, now = Date.now()): Promise<void> {
    await this.db.markPuzzleSeen(accountIds.map((accountId) => ({ accountId, puzzleId, atEpochMs: now })));
  }
}
