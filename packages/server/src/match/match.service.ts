/**
 * 판 구동 (AREA-PLAY)
 *
 * 서버가 시계를 갖는다(§2.2). 상태는 프로세스 밖에 있고(§4), **타이머는 상태가 아니라서
 * 부팅 때 종료 시각에서 다시 건다** — 만료를 지나친 판은 발견 시각이 아니라 **종료 시각**
 * 기준으로 채점한다(§4.1).
 */
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CELL_RELAY_PERIOD_MS, PROGRESS_PERIOD_MS,
} from '@sudoku/contracts';
import type { CellRelay, MatchStarted, Progress, ServerMessage } from '@sudoku/contracts';
import {
  cancelTeamSubmit, createMatch, dueEndReason, elapsedSec, finalizeMatch, fireTeamSubmit,
  markKicked, markLeft, requestHint, requestTeamSubmit, setCell, setConnected, setCursor,
  submitRace, submitBlockedReason, boardOf, filledCount, SUBMIT_LIMIT,
  type EndReason, type FinalizedMatch, type MatchState,
} from '@sudoku/core';
import type { StateStore } from '../storage/ports.js';
import { fromStored, toStored, type StoredMatch } from './match.serde.js';

const matchKey = (id: string) => `match:${id}`;

export type Broadcast = (roomId: string, msg: ServerMessage) => void;
export type Direct = (accountId: string, msg: ServerMessage) => void;
export type OnFinalized = (m: MatchState, f: FinalizedMatch) => Promise<void>;

interface Live {
  state: MatchState;
  relayQueue: CellRelay['changes'];
  /** 입력 간격 원자료 — 판이 끝나면 요약만 남기고 버린다(ADR §6.2.1) */
  inputTimes: Map<string, number[]>;
  timers: NodeJS.Timeout[];
}

@Injectable()
export class MatchService implements OnModuleDestroy {
  private readonly log = new Logger('Match');
  private readonly live = new Map<string, Live>();
  private broadcast: Broadcast = () => {};
  private direct: Direct = () => {};
  private onFinalized: OnFinalized = async () => {};

  constructor(@Inject('StateStore') private readonly state: StateStore) {}

  wire(b: Broadcast, d: Direct, f: OnFinalized): void {
    this.broadcast = b; this.direct = d; this.onFinalized = f;
  }

  get(matchId: string): MatchState | null { return this.live.get(matchId)?.state ?? null; }
  matchOfRoom(roomId: string): MatchState | null {
    for (const l of this.live.values()) if (l.state.roomId === roomId && l.state.finalizedAtEpochMs === null) return l.state;
    return null;
  }

  private async persist(m: MatchState): Promise<void> {
    await this.state.set<StoredMatch>(matchKey(m.matchId), toStored(m));
  }

  async startMatch(input: Parameters<typeof createMatch>[0] & { roomId: string }): Promise<MatchState> {
    const m = createMatch(input);
    await this.persist(m);
    this.attach(m);
    this.broadcast(m.roomId, { t: 'match:started', match: this.startedPayload(m) });
    return m;
  }

  startedPayload(m: MatchState): MatchStarted {
    return {
      matchId: m.matchId, mode: m.mode, difficulty: m.difficulty, limitSec: m.limitSec,
      endsAtEpochMs: m.endsAtEpochMs, serverNowEpochMs: Date.now(),
      givens: [...m.givens],                       // 원본 단서뿐. 정답은 이 페이로드에 없다
      hintsAllowed: m.hintsAllowed, violationDisplay: m.violationDisplay,
      rankEligible: m.rankEligible,
      participants: [...m.participants.values()].map((p) => ({ accountId: p.accountId, nickname: p.nickname, colorIndex: p.colorIndex })),
    };
  }

  /** 재접속·새로고침 — 서버가 그 참가자의 현재 상태를 통째로 내려보낸다(§4) */
  snapshotFor(m: MatchState, accountId: string): ServerMessage {
    const p = m.participants.get(accountId)!;
    const submitsUsed = m.mode === 'coop' ? m.team!.submitsUsed : p.submitsUsed;
    const hintsUsed = m.mode === 'coop' ? m.team!.hintsUsed : p.hintsUsed;
    return {
      t: 'match:snapshot',
      match: this.startedPayload(m),
      cells: [...boardOf(m, accountId)],
      submitsUsed,
      hintsUsed,
      finished: p.finished,
    };
  }

  private attach(m: MatchState): void {
    const live: Live = { state: m, relayQueue: [], inputTimes: new Map(), timers: [] };
    this.live.set(m.matchId, live);

    const progress = setInterval(() => { void this.tickProgress(m.matchId); }, PROGRESS_PERIOD_MS);
    live.timers.push(progress);
    if (m.mode === 'coop') {
      const relay = setInterval(() => this.tickRelay(m.matchId), CELL_RELAY_PERIOD_MS);
      live.timers.push(relay);
    }
    const watchdog = setInterval(() => { void this.tickEnd(m.matchId); }, 250);
    live.timers.push(watchdog);
    for (const t of live.timers) t.unref?.();
  }

  private detach(matchId: string): void {
    const l = this.live.get(matchId);
    if (!l) return;
    for (const t of l.timers) clearInterval(t);
    this.live.delete(matchId);
  }

  buildProgress(m: MatchState): Progress {
    const at = Date.now();
    if (m.mode === 'race') {
      return {
        kind: 'race', atEpochMs: at,
        participants: [...m.participants.values()].map((p) => ({
          accountId: p.accountId,
          filled: filledCount(p.cells, m.givens),
          finished: p.finished, connected: p.connected, left: p.left || p.kicked,
        })),
      };
    }
    const t = m.team!;
    return {
      kind: 'coop', atEpochMs: at,
      team: { filled: filledCount(t.cells, m.givens), finished: t.finished },
      cursors: [...m.participants.values()].map((p) => ({ accountId: p.accountId, index: p.cursor })),
      members: [...m.participants.values()].map((p) => ({ accountId: p.accountId, connected: p.connected, left: p.left || p.kicked })),
    };
  }

  private async tickProgress(matchId: string): Promise<void> {
    const l = this.live.get(matchId);
    if (!l || l.state.finalizedAtEpochMs !== null) return;
    this.broadcast(l.state.roomId, { t: 'progress', progress: this.buildProgress(l.state) });
  }

  private tickRelay(matchId: string): void {
    const l = this.live.get(matchId);
    if (!l || l.relayQueue.length === 0) return;
    const changes = l.relayQueue;
    l.relayQueue = [];
    this.broadcast(l.state.roomId, { t: 'cells', relay: { atEpochMs: Date.now(), changes } });
  }

  /** 종료 조건 셋을 본다. 협동의 5초 취소 창도 여기서 발사된다 */
  private async tickEnd(matchId: string): Promise<void> {
    const l = this.live.get(matchId);
    if (!l) return;
    const m = l.state;
    const now = Date.now();

    if (m.mode === 'coop' && m.team!.window && now >= m.team!.window.endsAtMs) {
      const by = m.team!.window.byAccountId;
      const fired = fireTeamSubmit(m, now);
      if (fired.fired && fired.outcome) {
        this.broadcast(m.roomId, { t: 'submit:window', window: {
          state: 'fired', byAccountId: by,
          byNickname: m.participants.get(by)?.nickname ?? '', endsAtEpochMs: now, isLastSubmit: false,
        } });
        this.broadcast(m.roomId, { t: 'submit:result', result: {
          passed: true, submitsUsed: fired.outcome.submitsUsed, submitsLimit: SUBMIT_LIMIT,
          finishedAtElapsedSec: fired.outcome.finishedAtElapsedSec,
        } });
        await this.persist(m);
      }
    }

    const reason = dueEndReason(m, now);
    if (reason) await this.finish(m, reason, reason === 'time-expired' ? m.endsAtEpochMs : now);
  }

  async finish(m: MatchState, reason: EndReason, atEpochMs: number): Promise<void> {
    if (m.finalizedAtEpochMs !== null) return;
    const l = this.live.get(m.matchId);
    const f = finalizeMatch(m, reason, atEpochMs);
    await this.persist(m);
    this.detach(m.matchId);

    // 입력 간격 요약을 만들고 원자료는 버린다 (ADR §6.2.1)
    const summaries = l ? summarizeInputs(m.matchId, l.inputTimes) : [];
    await this.onFinalized(m, { ...f, inputSummaries: summaries } as FinalizedMatch & { inputSummaries: InputSummary[] });
    await this.state.del(matchKey(m.matchId));
  }

  // ── 참가자 동작 ──────────────────────────────────────────────────────────
  async handleCell(m: MatchState, accountId: string, index: number, value: number): Promise<void> {
    const now = Date.now();
    const r = setCell(m, accountId, index, value, now);
    if (!r.ok) return;                              // 서버가 조용히 버린다(취소 창 등)
    const l = this.live.get(m.matchId);
    if (l) {
      const times = l.inputTimes.get(accountId) ?? l.inputTimes.set(accountId, []).get(accountId)!;
      times.push(now);
      if (r.change) l.relayQueue.push({ index: r.change.index, value: r.change.value, byAccountId: r.change.by, seq: r.change.seq });
    }
    await this.persist(m);
  }

  async handleSubmit(m: MatchState, accountId: string): Promise<void> {
    const now = Date.now();
    if (m.mode === 'race') {
      const r = submitRace(m, accountId, now);
      if (!r.ok || !r.outcome) {
        this.direct(accountId, { t: 'notice', level: 'warn', code: r.reason ?? 'submit-blocked', text: noticeFor(r.reason) });
        return;
      }
      this.direct(accountId, { t: 'submit:result', result: {
        passed: true, submitsUsed: r.outcome.submitsUsed, submitsLimit: SUBMIT_LIMIT,
        finishedAtElapsedSec: r.outcome.finishedAtElapsedSec,
      } });
      await this.persist(m);
      return;
    }
    const r = requestTeamSubmit(m, accountId, now);
    if (!r.ok) {
      this.direct(accountId, { t: 'notice', level: 'warn', code: r.reason ?? 'submit-blocked', text: noticeFor(r.reason) });
      return;
    }
    const p = m.participants.get(accountId)!;
    this.broadcast(m.roomId, { t: 'submit:window', window: {
      state: 'open', byAccountId: accountId, byNickname: p.nickname,
      endsAtEpochMs: r.endsAtMs!, isLastSubmit: r.isLast ?? false,
    } });
    await this.persist(m);
  }

  async handleCancel(m: MatchState, accountId: string): Promise<void> {
    const now = Date.now();
    const win = m.team?.window;
    const r = cancelTeamSubmit(m, accountId, now);
    if (!r.ok || !win) return;
    const p = m.participants.get(accountId)!;
    this.broadcast(m.roomId, { t: 'submit:window', window: {
      state: 'cancelled', byAccountId: win.byAccountId,
      byNickname: m.participants.get(win.byAccountId)?.nickname ?? '',
      cancelledByNickname: p.nickname, endsAtEpochMs: now, isLastSubmit: false,
      cooldownUntilEpochMs: m.team!.cooldownUntilMs,
    } });
    await this.persist(m);
  }

  async handleHint(m: MatchState, accountId: string): Promise<void> {
    const r = requestHint(m, accountId, Date.now());
    if (!r.ok) {
      this.direct(accountId, { t: 'notice', level: 'info', code: r.reason ?? 'hint-blocked', text: noticeFor(r.reason) });
      return;
    }
    const limit = 3;
    const msg: ServerMessage = { t: 'hint:result', hint: { index: r.index!, technique: r.technique!, used: r.used!, limit } };
    if (m.mode === 'coop') this.broadcast(m.roomId, msg); else this.direct(accountId, msg);
    await this.persist(m);
  }

  async handleCursor(m: MatchState, accountId: string, index: number | null): Promise<void> {
    setCursor(m, accountId, index);
  }
  async handleLeave(m: MatchState, accountId: string): Promise<void> { markLeft(m, accountId); await this.persist(m); }
  async handleKick(m: MatchState, accountId: string): Promise<void> { markKicked(m, accountId); await this.persist(m); }
  async handleConnection(m: MatchState, accountId: string, connected: boolean): Promise<void> {
    setConnected(m, accountId, connected); await this.persist(m);
  }
  submitBlocked(m: MatchState, accountId: string): string | null { return submitBlockedReason(m, accountId); }
  elapsed(m: MatchState): number { return elapsedSec(m, Date.now()); }

  /**
   * 부팅 복구 (§4.1) — 진행 중이던 판을 훑어 타이머를 다시 걸고,
   * 만료를 지나친 판은 **종료 시각 기준으로** 그 자리에서 채점한다.
   */
  async recoverOnBoot(): Promise<{ resumed: string[]; finalized: string[] }> {
    const keys = await this.state.keys('match:');
    const resumed: string[] = [], finalized: string[] = [];
    for (const k of keys) {
      const stored = await this.state.get<StoredMatch>(k);
      if (!stored) continue;
      const m = fromStored(stored);
      if (m.finalizedAtEpochMs !== null) { await this.state.del(k); continue; }
      if (Date.now() >= m.endsAtEpochMs) {
        this.log.warn(`판 ${m.matchId} 은 만료를 지나쳤다 — 종료 시각 기준으로 채점한다`);
        this.live.set(m.matchId, { state: m, relayQueue: [], inputTimes: new Map(), timers: [] });
        await this.finish(m, 'time-expired', m.endsAtEpochMs);
        finalized.push(m.matchId);
      } else {
        this.attach(m);
        resumed.push(m.matchId);
      }
    }
    return { resumed, finalized };
  }

  shutdown(): void { for (const id of [...this.live.keys()]) this.detach(id); }
  /** 앱이 닫히면 타이머도 함께 선다 — 닫힌 뒤에도 도는 타이머가 상태를 덮어쓴다. */
  onModuleDestroy(): void { this.shutdown(); }
}

export interface InputSummary {
  matchId: string; accountId: string; inputs: number;
  medianGapMs: number; varianceMs2: number; minGapMs: number; p5GapMs: number;
}
/** 원본 타임스탬프가 아니라 분포 요약만 남긴다 */
export function summarizeInputs(matchId: string, times: Map<string, number[]>): InputSummary[] {
  const out: InputSummary[] = [];
  for (const [accountId, ts] of times) {
    if (ts.length < 2) { out.push({ matchId, accountId, inputs: ts.length, medianGapMs: 0, varianceMs2: 0, minGapMs: 0, p5GapMs: 0 }); continue; }
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
    gaps.sort((a, b) => a - b);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
    out.push({
      matchId, accountId, inputs: ts.length,
      medianGapMs: Math.round(gaps[Math.floor(gaps.length / 2)]!),
      varianceMs2: Math.round(variance),
      minGapMs: gaps[0]!,
      p5GapMs: gaps[Math.floor(gaps.length * 0.05)]!,
    });
  }
  return out;
}

function noticeFor(reason: string | undefined): string {
  switch (reason) {
    case 'incomplete': return '아직 빈칸이 남아 있습니다';
    case 'violation': return '제출할 수 없습니다 — 같은 줄이나 칸에 같은 숫자가 있습니다';
    case 'submit-limit': return '제출 횟수를 모두 썼습니다';
    case 'submit-window-open': return '제출 확인 중에는 입력할 수 없습니다';
    case 'cooldown': return '방금 취소했습니다 — 잠시 뒤 다시 제출할 수 있습니다';
    case 'hint-limit': return '힌트를 모두 썼습니다';
    case 'hints-not-allowed': return '이 판은 힌트를 쓸 수 없습니다';
    case 'board-full': return '빈칸이 없어 지목할 칸이 없습니다';
    case 'already-finished': return '이미 완주했습니다';
    case 'time-expired': return '제한 시간이 끝났습니다';
    default: return '지금은 할 수 없습니다';
  }
}
