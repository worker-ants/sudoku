/**
 * 판 구동 (AREA-PLAY)
 *
 * 서버가 시계를 갖는다(§2.2). 상태는 프로세스 밖에 있고(§4), **타이머는 상태가 아니라서
 * 부팅 때 종료 시각에서 다시 건다** — 만료를 지나친 판은 발견 시각이 아니라 **종료 시각**
 * 기준으로 채점한다(§4.1).
 *
 * ── 노드가 여럿일 때 ──────────────────────────────────────────────────────
 * **진행 중인 판은 노드 하나가 갖는다.** 칸 입력은 잦고, 매 입력마다 분산 잠금을 잡아
 * 읽고-고쳐-쓰기를 하면 왕복이 감당되지 않는다. 그래서 상태와 타이머를 **가진 노드의
 * 메모리에** 두고, 다른 노드에 붙은 참가자의 입력은 그 노드로 건너보낸다.
 *
 *   소유권   `matchowner:<matchId>` 에 노드 ID 를 수명과 함께 적는다. 가진 노드가
 *            주기적으로 늘리고, 죽으면 수명이 끝나 다른 노드가 주워 간다.
 *   명령     소유 노드가 `cmd:<roomId>` 를 구독한다. 나머지 노드는 거기로 발행한다.
 *   결과     나가는 메시지는 게이트웨이의 중계를 타고 모든 노드로 간다.
 *
 * 이 구조 덕에 **판 로직은 한 프로세스 안에서 돌던 그대로다** — 아래 handle* 들은
 * 노드가 하나였을 때와 같은 코드고, 달라진 것은 그것을 부르는 경로뿐이다.
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
import { commandChannel, type Bus } from '../cluster/bus.js';
import { fromStored, toStored, type StoredMatch } from './match.serde.js';

const matchKey = (id: string) => `match:${id}`;
const ownerKey = (id: string) => `matchowner:${id}`;

/**
 * 소유권의 수명과 갱신 주기.
 *
 * 짧을수록 죽은 노드의 판을 빨리 주워 오지만, 갱신이 한 번 늦으면 살아 있는 노드가
 * 제 판을 뺏긴다. 셋을 두 번 놓쳐도 버티도록 15초 : 5초로 둔다.
 */
const OWNER_TTL_MS = 15_000;
const OWNER_RENEW_MS = 5_000;

/**
 * 판에 건너가는 명령.
 *
 * 게이트웨이가 받은 클라이언트 메시지를 **그대로** 넘기지 않고 여기서 좁힌 모양으로
 * 옮긴다 — 버스를 타는 것은 JSON 이라, 실어도 되는 것이 무엇인지 타입으로 못박아 둔다.
 */
export type MatchCommand =
  | { t: 'cell'; accountId: string; index: number; value: number }
  | { t: 'cursor'; accountId: string; index: number | null }
  | { t: 'submit'; accountId: string }
  | { t: 'cancel'; accountId: string }
  | { t: 'hint'; accountId: string }
  | { t: 'history'; accountId: string; index: number }
  | { t: 'snapshot'; accountId: string }
  | { t: 'leave'; accountId: string }
  | { t: 'kick'; accountId: string }
  | { t: 'connection'; accountId: string; connected: boolean }
  | { t: 'finish'; reason: EndReason };

export type Broadcast = (roomId: string, msg: ServerMessage) => void;
export type Direct = (accountId: string, msg: ServerMessage) => void;
export type OnFinalized = (m: MatchState, f: FinalizedMatch) => Promise<void>;

interface Live {
  state: MatchState;
  relayQueue: CellRelay['changes'];
  /** 입력 간격 원자료 — 판이 끝나면 요약만 남기고 버린다(ADR §6.2.1) */
  inputTimes: Map<string, number[]>;
  timers: NodeJS.Timeout[];
  /** 소유권 갱신에 쓰는 토큰 — 내가 건 것만 늘리고 푼다 */
  ownerToken: string;
}

@Injectable()
export class MatchService implements OnModuleDestroy {
  private readonly log = new Logger('Match');
  private readonly live = new Map<string, Live>();
  private broadcast: Broadcast = () => {};
  private direct: Direct = () => {};
  private onFinalized: OnFinalized = async () => {};

  constructor(
    @Inject('StateStore') private readonly state: StateStore,
    @Inject('Bus') private readonly bus: Bus,
    @Inject('NodeId') private readonly nodeId: string,
  ) {}

  wire(b: Broadcast, d: Direct, f: OnFinalized): void {
    this.broadcast = b; this.direct = d; this.onFinalized = f;
  }

  get(matchId: string): MatchState | null { return this.live.get(matchId)?.state ?? null; }
  matchOfRoom(roomId: string): MatchState | null {
    for (const l of this.live.values()) if (l.state.roomId === roomId && l.state.finalizedAtEpochMs === null) return l.state;
    return null;
  }
  /**
   * 이 계정이 낀, **이 노드가 가진** 판.
   *
   * 게이트웨이가 계정 하나에게 보내는 메시지의 검사 문맥을 만들 때 쓴다 — 받는 사람의
   * 소켓이 다른 노드에 있어도 판을 가진 쪽이 검사해야 정답과 대조할 수 있다.
   */
  matchOfParticipant(accountId: string): MatchState | null {
    for (const l of this.live.values()) {
      if (l.state.finalizedAtEpochMs === null && l.state.participants.has(accountId)) return l.state;
    }
    return null;
  }

  private async persist(m: MatchState): Promise<void> {
    await this.state.set<StoredMatch>(matchKey(m.matchId), toStored(m));
  }

  async startMatch(input: Parameters<typeof createMatch>[0] & { roomId: string }): Promise<MatchState> {
    const m = createMatch(input);
    await this.persist(m);
    // 새 matchId 라 아무도 갖고 있지 않다 — 그래도 claim 을 거치는 이유는 attach 가
    // 소유권 없이 열리는 경로를 하나도 남기지 않기 위해서다.
    const token = await this.claim(m.matchId);
    if (!token) throw new Error(`판 ${m.matchId} 의 소유권을 잡지 못했다`);
    await this.attach(m, token);
    this.broadcast(m.roomId, { t: 'match:started', match: this.startedPayload(m) });
    return m;
  }

  // ── 소유권 ────────────────────────────────────────────────────────────────

  /** 잡히면 토큰, 이미 다른 노드가 갖고 있으면 null */
  private async claim(matchId: string): Promise<string | null> {
    const token = `${this.nodeId}:${randomUUID().slice(0, 8)}`;
    return (await this.state.acquire(ownerKey(matchId), token, OWNER_TTL_MS)) ? token : null;
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

  private async attach(m: MatchState, ownerToken: string): Promise<void> {
    const live: Live = { state: m, relayQueue: [], inputTimes: new Map(), timers: [], ownerToken };
    this.live.set(m.matchId, live);

    const progress = setInterval(() => { void this.tickProgress(m.matchId); }, PROGRESS_PERIOD_MS);
    live.timers.push(progress);
    if (m.mode === 'coop') {
      const relay = setInterval(() => this.tickRelay(m.matchId), CELL_RELAY_PERIOD_MS);
      live.timers.push(relay);
    }
    const watchdog = setInterval(() => { void this.tickEnd(m.matchId); }, 250);
    live.timers.push(watchdog);
    // 소유권을 놓치면 이 판은 더 이상 내 것이 아니다 — 타이머를 세우고 손을 뗀다.
    // 그러지 않으면 새 주인과 둘이서 같은 판을 굴린다.
    live.timers.push(setInterval(() => { void this.heartbeat(m.matchId); }, OWNER_RENEW_MS));
    for (const t of live.timers) t.unref?.();

    // 다른 노드에 붙은 참가자의 입력이 이리로 온다
    await this.bus.subscribe(commandChannel(m.roomId), (payload) => {
      void this.apply(m.matchId, payload as MatchCommand);
    });
  }

  private async heartbeat(matchId: string): Promise<void> {
    const l = this.live.get(matchId);
    if (!l) return;
    if (await this.state.renew(ownerKey(matchId), l.ownerToken, OWNER_TTL_MS)) return;
    this.log.warn(`판 ${matchId} 의 소유권을 잃었다 — 손을 뗀다`);
    await this.release(matchId, { keepOwnerKey: true });
  }

  private async detach(matchId: string): Promise<void> { await this.release(matchId); }

  /**
   * 판을 이 노드에서 뗀다.
   *
   * `keepOwnerKey` 는 **소유권을 이미 잃은** 경우다 — 그 키는 새 주인의 것이므로
   * 지우면 안 된다. 평소에는 지워서 다음 주인이 수명을 기다리지 않게 한다.
   */
  private async release(matchId: string, opts: { keepOwnerKey?: boolean } = {}): Promise<void> {
    const l = this.live.get(matchId);
    if (!l) return;
    for (const t of l.timers) clearInterval(t);
    this.live.delete(matchId);
    // 같은 룸의 다른 판을 아직 갖고 있지 않을 때만 채널을 놓는다
    if (![...this.live.values()].some((x) => x.state.roomId === l.state.roomId)) {
      await this.bus.unsubscribe(commandChannel(l.state.roomId));
    }
    if (!opts.keepOwnerKey) await this.state.release(ownerKey(matchId), l.ownerToken);
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
          byNickname: m.participants.get(by)?.nickname ?? '', endsAtEpochMs: now,
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
    await this.detach(m.matchId);

    // 입력 간격 요약을 만들고 원자료는 버린다 (ADR §6.2.1)
    const summaries = l ? summarizeInputs(m.matchId, l.inputTimes) : [];
    await this.onFinalized(m, { ...f, inputSummaries: summaries } as FinalizedMatch & { inputSummaries: InputSummary[] });
    await this.state.del(matchKey(m.matchId));
  }

  // ── 명령 라우팅 ──────────────────────────────────────────────────────────

  /**
   * 룸의 판에 명령을 보낸다.
   *
   * 내가 가진 판이면 그 자리에서 처리하고, 아니면 버스로 넘긴다. 아무 노드도 갖고
   * 있지 않으면(=진행 중인 판이 없으면) 아무 일도 일어나지 않는다 — 노드가 하나였을 때
   * `if (match)` 로 조용히 넘어가던 것과 같은 결말이다.
   *
   * 발행은 자기 자신에게도 돌아오지만, 내가 가진 경우는 위에서 이미 걸러졌으므로
   * 같은 명령이 두 번 적용되지 않는다.
   */
  async command(roomId: string, cmd: MatchCommand): Promise<void> {
    const m = this.matchOfRoom(roomId);
    if (m) { await this.apply(m.matchId, cmd); return; }
    await this.bus.publish(commandChannel(roomId), cmd);
  }

  /** 소유 노드에서만 돈다 */
  private async apply(matchId: string, cmd: MatchCommand): Promise<void> {
    const m = this.get(matchId);
    if (!m) return;
    try {
      switch (cmd.t) {
        case 'cell': return await this.handleCell(m, cmd.accountId, cmd.index, cmd.value);
        case 'cursor': return await this.handleCursor(m, cmd.accountId, cmd.index);
        case 'submit': return await this.handleSubmit(m, cmd.accountId);
        case 'cancel': return await this.handleCancel(m, cmd.accountId);
        case 'hint': return await this.handleHint(m, cmd.accountId);
        case 'leave': return await this.handleLeave(m, cmd.accountId);
        case 'kick': return await this.handleKick(m, cmd.accountId);
        case 'connection': return await this.handleConnection(m, cmd.accountId, cmd.connected);
        case 'finish': return await this.finish(m, cmd.reason, Date.now());
        case 'snapshot': {
          // 참가자가 아니면 보낼 것이 없다 — 다른 룸의 소켓이 잘못 물린 경우다
          if (!m.participants.has(cmd.accountId)) return;
          this.direct(cmd.accountId, this.snapshotFor(m, cmd.accountId));
          return;
        }
        case 'history': {
          // 협동만이다 — 레이스는 보드가 각자의 것이라 "남이 채운 칸" 이 없다(COOP §7)
          if (m.mode !== 'coop' || !m.team) return;
          const entries = (m.team.changeLog.get(cmd.index) ?? [])
            .map((e) => ({ value: e.value, accountId: e.by, atEpochMs: e.atMs }));
          this.direct(cmd.accountId, { t: 'cell:history', index: cmd.index, entries });
          return;
        }
      }
    } catch (e) {
      // 버스를 타고 온 명령이 던지면 처리되지 않은 거부가 된다 — 부른 사람이 없다.
      this.log.error(`판 명령 ${cmd.t} 실패 — ${e instanceof Error ? e.message : String(e)}`);
    }
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
      endsAtEpochMs: r.endsAtMs!,
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
      cancelledByNickname: p.nickname, endsAtEpochMs: now,
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
   * 주인 없는 판을 주워 온다 (§4.1).
   *
   * 노드가 하나였을 때는 "부팅 복구" 였다 — 죽었다 살아난 그 프로세스가 자기 판을
   * 도로 집었다. 노드가 여럿이면 같은 동작이 **두 가지 일**을 겸한다.
   *
   *   부팅   갓 뜬 노드가 아무도 갖고 있지 않은 판을 집는다.
   *   장애   노드가 죽으면 그 판의 소유권이 수명을 다한다. 살아 있는 노드가 주워 간다.
   *
   * 그래서 부팅 때 한 번이 아니라 **주기적으로** 돈다(main.ts). 소유권을 먼저 잡고
   * 잡힌 것만 여는 것이 핵심이다 — 그러지 않으면 노드 셋이 같은 판을 셋 다 굴린다.
   *
   * 만료를 지나친 판은 발견 시각이 아니라 **종료 시각** 기준으로 채점한다.
   */
  async adoptOrphans(): Promise<{ resumed: string[]; finalized: string[] }> {
    const keys = await this.state.keys('match:');
    const resumed: string[] = [], finalized: string[] = [];
    for (const k of keys) {
      const matchId = k.slice('match:'.length);
      if (this.live.has(matchId)) continue;                  // 이미 내 것이다

      const stored = await this.state.get<StoredMatch>(k);
      if (!stored) continue;
      const m = fromStored(stored);
      if (m.finalizedAtEpochMs !== null) {
        // 확정된 뒤 흔적만 남은 것 — 소유권을 잡을 수 있을 때만 치운다.
        const t = await this.claim(matchId);
        if (t) { await this.state.del(k); await this.state.release(ownerKey(matchId), t); }
        continue;
      }

      const token = await this.claim(matchId);
      if (!token) continue;                                  // 다른 노드가 갖고 있다

      if (Date.now() >= m.endsAtEpochMs) {
        this.log.warn(`판 ${m.matchId} 은 만료를 지나쳤다 — 종료 시각 기준으로 채점한다`);
        this.live.set(m.matchId, { state: m, relayQueue: [], inputTimes: new Map(), timers: [], ownerToken: token });
        await this.finish(m, 'time-expired', m.endsAtEpochMs);
        finalized.push(m.matchId);
      } else {
        await this.attach(m, token);
        resumed.push(m.matchId);
      }
    }
    return { resumed, finalized };
  }

  /** 부팅 시점의 이름 — 하는 일은 같다 */
  recoverOnBoot(): Promise<{ resumed: string[]; finalized: string[] }> { return this.adoptOrphans(); }

  /**
   * 이 노드가 든 판을 전부 놓는다.
   *
   * 소유권 키까지 지운다 — 정상 종료라면 다음 노드가 15초를 기다릴 이유가 없다.
   * 롤링 배포에서 이 한 줄이 단절을 수십 초에서 다음 스윕까지로 줄인다.
   */
  async shutdown(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.detach(id);
  }
  /** 앱이 닫히면 타이머도 함께 선다 — 닫힌 뒤에도 도는 타이머가 상태를 덮어쓴다. */
  onModuleDestroy(): void { void this.shutdown(); }
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
