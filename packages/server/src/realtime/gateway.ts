/**
 * socket.io 게이트웨이 — **나가는 메시지의 단일 지점**이다.
 * 여기를 지나지 않고 나가는 페이로드는 없고, 그래서 전송 가드가 자동으로 따라붙는다.
 *
 * ── 노드가 여럿일 때 ──────────────────────────────────────────────────────
 * 한 룸의 참가자들이 서로 다른 노드에 붙어 있을 수 있다. 그래서 나가는 메시지는
 * 소켓에 바로 쓰지 않고 **버스에 실어 모든 노드가 자기 소켓에 뿌린다.**
 *
 * **가드는 메시지를 만든 노드에서 한 번 돈다.** 정답을 알고 있는 노드가 그 판을 가진
 * 노드이고, 검사는 정답과 대조하는 일이라 그 자리에서만 뜻이 있다. 중계를 받은 노드는
 * 이미 검사를 통과한 페이로드를 전달만 한다 — 검사를 건너뛰는 것이 아니라, 검사가
 * 일어난 곳이 한 칸 앞일 뿐이다.
 */
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect,
  SubscribeMessage, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { LOBBY_PERIOD_MS, type ChatMessage, type ClientMessage, type ServerMessage } from '@sudoku/contracts';
import type { Difficulty } from '@sudoku/core';
import { AuthService } from '../auth/auth.service.js';
import { RoomService, RoomError, type RoomState } from '../room/room.service.js';
import { MatchService } from '../match/match.service.js';
import { PuzzlePoolService } from '../match/puzzle-pool.service.js';
import { RankingService } from '../ranking/ranking.service.js';
import { assertNoSolutionLeak, SolutionLeakError } from './emit-guard.js';
import { TokenBucket, chatOpen, CHAT_MAX_LEN } from './chat.js';
import { RELAY_CHANNEL, type Bus } from '../cluster/bus.js';
import type { StateStore } from '../storage/ports.js';

interface SocketData { accountId: string; nickname: string; roomId: string | null; bucket: TokenBucket }

/** 버스에 실려 노드들 사이를 오가는 것 */
type Relay =
  | { kind: 'room'; roomId: string; msg: ServerMessage }
  | { kind: 'account'; accountId: string; msg: ServerMessage }
  /** 계정당 소켓 하나 — 다른 노드에 남은 옛 연결을 끊게 한다 */
  | { kind: 'evict'; accountId: string; exceptNodeId: string; exceptSocketId: string };

@Injectable()
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger('Gateway');
  private readonly sockets = new Map<string, Socket>();       // accountId → 마지막 연결
  private readonly lobbyWatchers = new Set<string>();
  private lobbyTimer: NodeJS.Timeout | null = null;

  // ESM 런타임에서는 design:paramtypes 메타데이터에 기대지 않는다 — 토큰을 명시한다
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RoomService) private readonly rooms: RoomService,
    @Inject(MatchService) private readonly matches: MatchService,
    @Inject(PuzzlePoolService) private readonly pool: PuzzlePoolService,
    @Inject(RankingService) private readonly ranking: RankingService,
    @Inject('Bus') private readonly bus: Bus,
    @Inject('NodeId') private readonly nodeId: string,
    @Inject('StateStore') private readonly state: StateStore,
  ) {
    this.matches.wire(
      (roomId, msg) => this.toRoom(roomId, msg),
      (accountId, msg) => this.toAccount(accountId, msg),
      async (m, f) => {
        const { ratingDeltas } = await this.ranking.handoff(m, f);
        const room = await this.rooms.withLock(async () => {
          const room = await this.rooms.get(m.roomId);
          if (!room) return null;
          room.phase = 'result';
          room.currentMatchId = null;
          room.currentMatchEndsAtMs = null;
          room.lastResultMatchId = m.matchId;
          room.lastActivityAtMs = Date.now();
          for (const mem of room.members) mem.ready = false;
          await this.rooms.save(room);
          return room;
        });
        // **확정된 뒤에만** 나갈 수 있는 메시지다 — 가드가 그 순서를 강제한다
        this.toRoom(m.roomId, {
          t: 'match:ended',
          result: {
            matchId: f.matchId, mode: m.mode, endReason: f.endReason, rankEligible: f.rankEligible,
            limitSec: f.limitSec, solutionRevealed: f.solution,
            boards: f.participants.map((p) => ({ accountId: p.accountId, cells: p.cells })),
            participants: f.participants.map((p) => ({
              accountId: p.accountId, nickname: p.nickname, finished: p.finished,
              adjustedFinishSec: p.adjustedFinishSec, correctCells: p.correctCells,
              violations: p.violations, hintsUsed: p.hintsUsed,
              rank: p.rank, rankPoint: p.rankPoint, left: p.left, kicked: p.kicked,
              ratingDelta: ratingDeltas.get(p.accountId) ?? null,
              contribution: p.contribution, gatePassed: p.gatePassed, requiredContribution: p.requiredContribution,
            })),
            team: f.team ? { finished: f.team.finished, adjustedFinishSec: f.team.adjustedFinishSec, teamPoint: f.team.teamPoint, hintsUsed: f.team.hintsUsed } : undefined,
          },
        }, { finalizedMatchId: f.matchId });
        if (room) this.toRoom(room.roomId, { t: 'room:state', room: this.rooms.toRoomView(room) });
      },
    );
  }

  // ── 단일 emit 지점 ───────────────────────────────────────────────────────
  //
  // 세 단계로 나뉜다.
  //   check    정답 유출 검사. **메시지를 만든 노드에서** 한 번 돈다.
  //   toRoom/toAccount   검사를 통과한 것을 버스에 싣는다.
  //   deliver  중계를 받아 이 노드의 소켓에 쓴다.
  //
  // 노드가 하나뿐이면 발행이 자기에게 돌아와 deliver 로 이어진다 — 경로가 하나다.

  /** 통과하면 true. 막히면 로그를 남기고 false — 조용히 나가는 일은 없다 */
  private check(match: { solution?: readonly number[]; finalizedAtEpochMs: number | null } | null, msg: ServerMessage, opts: { finalizedMatchId?: string }): boolean {
    const finalized = opts.finalizedMatchId !== undefined || match === null || match.finalizedAtEpochMs !== null;
    try {
      assertNoSolutionLeak(msg, { solution: match?.solution, finalized });
      return true;
    } catch (e) {
      if (e instanceof SolutionLeakError) { this.log.error(`전송 차단 — ${e.message}`); return false; }
      throw e;
    }
  }

  /** 이 소켓 하나에만 — 검사도 여기서 한다 (요청을 받은 노드가 곧 답하는 자리) */
  private emit(socket: Socket, msg: ServerMessage, opts: { finalizedMatchId?: string } = {}): void {
    const data = socket.data as SocketData;
    const match = data.roomId ? this.matches.matchOfRoom(data.roomId) : null;
    if (!this.check(match, msg, opts)) return;
    socket.emit('msg', msg);
  }

  private toRoom(roomId: string, msg: ServerMessage, opts: { finalizedMatchId?: string } = {}): void {
    if (!this.check(this.matches.matchOfRoom(roomId), msg, opts)) return;
    void this.bus.publish(RELAY_CHANNEL, { kind: 'room', roomId, msg } satisfies Relay);
  }

  private toAccount(accountId: string, msg: ServerMessage): void {
    // 이 계정이 낀 판을 찾아 검사 문맥을 만든다. 소켓이 이 노드에 없을 수도 있으므로
    // (다른 노드에 붙어 있고 우리는 판만 가진 경우) 판 쪽에서 먼저 찾는다.
    const match = this.matches.matchOfParticipant(accountId)
      ?? (() => { const r = (this.sockets.get(accountId)?.data as SocketData | undefined)?.roomId; return r ? this.matches.matchOfRoom(r) : null; })();
    if (!this.check(match, msg, {})) return;
    void this.bus.publish(RELAY_CHANNEL, { kind: 'account', accountId, msg } satisfies Relay);
  }

  /** 중계를 받아 이 노드의 소켓에 쓴다 — 검사는 보낸 노드에서 이미 끝났다 */
  private deliver(relay: Relay): void {
    switch (relay.kind) {
      case 'room':
        for (const s of this.server.sockets.sockets.values()) {
          if ((s.data as SocketData)?.roomId === relay.roomId) s.emit('msg', relay.msg);
        }
        return;
      case 'account': {
        const s = this.sockets.get(relay.accountId);
        if (s) s.emit('msg', relay.msg);
        return;
      }
      case 'evict': {
        const s = this.sockets.get(relay.accountId);
        if (!s) return;
        if (this.nodeId === relay.exceptNodeId && s.id === relay.exceptSocketId) return;   // 새 연결 본인
        s.emit('msg', { t: 'notice', level: 'warn', code: 'replaced', text: '다른 곳에서 접속했습니다' } satisfies ServerMessage);
        this.sockets.delete(relay.accountId);
        s.disconnect(true);
        return;
      }
    }
  }

  /** 노드가 뜰 때 중계를 듣기 시작한다 */
  async joinCluster(): Promise<void> {
    await this.bus.subscribe(RELAY_CHANNEL, (payload) => this.deliver(payload as Relay));
  }

  // ── 연결 ────────────────────────────────────────────────────────────────
  /**
   * 연결 처리에서 새는 예외는 **처리되지 않은 거부**가 된다 — socket.io 는 이 훅을
   * 기다리지 않기 때문이다. 저장소가 잠깐 흔들리면 프로세스가 죽는 자리라, 여기서 막고
   * 소켓만 끊는다. 클라이언트는 어차피 재연결한다.
   */
  async handleConnection(socket: Socket): Promise<void> {
    try { await this.onConnect(socket); }
    catch (e) {
      this.log.error(`연결 처리 실패 — 소켓을 끊는다: ${e instanceof Error ? e.message : String(e)}`);
      socket.disconnect(true);
    }
  }

  private async onConnect(socket: Socket): Promise<void> {
    const cookie = socket.handshake.headers.cookie ?? '';
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(cookie)?.[1];
    const account = await this.auth.resolveSession(sid ? decodeURIComponent(sid) : undefined);
    if (!account) { socket.disconnect(true); return; }

    this.sockets.set(account.accountId, socket);
    // 룸 소켓은 계정당 하나 — 마지막 연결이 이긴다(AREA-ROOM §2.2).
    // **노드를 건너서도** 그래야 한다. 옛 연결이 다른 노드에 남아 있으면 그 노드가 끊는다.
    void this.bus.publish(RELAY_CHANNEL, {
      kind: 'evict', accountId: account.accountId, exceptNodeId: this.nodeId, exceptSocketId: socket.id,
    } satisfies Relay);

    const room = await this.rooms.membershipOf(account.accountId);
    socket.data = { accountId: account.accountId, nickname: account.nickname, roomId: room?.roomId ?? null, bucket: new TokenBucket() } satisfies SocketData;
    if (room) {
      await this.rooms.setConnected(account.accountId, true);
      const fresh = (await this.rooms.get(room.roomId))!;
      this.emit(socket, { t: 'room:state', room: this.rooms.toRoomView(fresh) });
      if (fresh.currentMatchId) {
        // 판을 가진 노드가 스냅샷을 만들어 이 계정에게 보낸다 — 여기서는 만들 수 없다.
        await this.matches.command(room.roomId, { t: 'connection', accountId: account.accountId, connected: true });
        await this.matches.command(room.roomId, { t: 'snapshot', accountId: account.accountId });
      }
      this.toRoom(room.roomId, { t: 'room:state', room: this.rooms.toRoomView(fresh) });
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const d = socket.data as SocketData;
    if (!d?.accountId) return;
    if (this.sockets.get(d.accountId)?.id === socket.id) this.sockets.delete(d.accountId);
    this.lobbyWatchers.delete(socket.id);
    const room = await this.rooms.setConnected(d.accountId, false);
    if (room) {
      if (room.currentMatchId) await this.matches.command(room.roomId, { t: 'connection', accountId: d.accountId, connected: false });
      this.toRoom(room.roomId, { t: 'room:state', room: this.rooms.toRoomView(room) });
    }
  }

  @SubscribeMessage('msg')
  async onMessage(@ConnectedSocket() socket: Socket, @MessageBody() body: ClientMessage): Promise<void> {
    const d = socket.data as SocketData;
    try { await this.dispatch(socket, d, body); }
    catch (e) {
      const text = e instanceof RoomError ? e.message : '처리하지 못했습니다';
      const code = e instanceof RoomError ? e.code : 'error';
      this.emit(socket, { t: 'notice', level: 'error', code, text });
    }
  }

  /**
   * 재촉 알림의 창 (READY §5.1 — 30초에 한 번).
   *
   * 룸 상태에 넣지 않는다 — 룸 스냅샷에 넣으면 직렬화와 복구 경로가 이 값 때문에 늘어난다.
   * 대신 상태 저장소에 **수명이 달린 키 하나**로 둔다. 프로세스 안 Map 이었을 때는
   * 노드를 바꿔 가며 누르면 창이 무의미해졌다 — 남용 방지가 노드 수만큼 헐거워지는 셈이다.
   * 키가 있으면 아직 창 안이고, 없으면 지난 것이다. 시각을 비교하지 않는다.
   */
  private static readonly NUDGE_INTERVAL_MS = 30_000;
  private static nudgeKey(roomId: string): string { return `nudge:${roomId}`; }

  private async dispatch(socket: Socket, d: SocketData, msg: ClientMessage): Promise<void> {
    // 판을 건드리는 것은 전부 `command` 를 지난다. 이 노드가 그 판을 가졌으면 그 자리에서,
    // 아니면 가진 노드로 건너간다 — 부르는 쪽은 어느 쪽인지 알 필요가 없다.
    const room = d.roomId;
    switch (msg.t) {
      case 'cell:set': if (room) await this.matches.command(room, { t: 'cell', accountId: d.accountId, index: msg.index, value: msg.value }); return;
      case 'cursor:set': if (room) await this.matches.command(room, { t: 'cursor', accountId: d.accountId, index: msg.index }); return;
      case 'cell:history': if (room) await this.matches.command(room, { t: 'history', accountId: d.accountId, index: msg.index }); return;
      case 'submit:request': if (room) await this.matches.command(room, { t: 'submit', accountId: d.accountId }); return;
      case 'submit:cancel': if (room) await this.matches.command(room, { t: 'cancel', accountId: d.accountId }); return;
      case 'hint:request': if (room) await this.matches.command(room, { t: 'hint', accountId: d.accountId }); return;
      case 'ready:toggle': { const r = await this.rooms.toggleReady(d.accountId); this.pushRoom(r); return; }
      case 'ready:nudge': {
        const room = await this.rooms.membershipOf(d.accountId);
        if (!room) return;
        if (room.hostAccountId !== d.accountId) {
          this.emit(socket, { t: 'notice', level: 'warn', code: 'not-host', text: '호스트만 재촉할 수 있습니다' });
          return;
        }
        const openedAt = await this.state.get<number>(RealtimeGateway.nudgeKey(room.roomId));
        if (openedAt !== null) {
          const leftSec = Math.max(1, Math.ceil((RealtimeGateway.NUDGE_INTERVAL_MS - (Date.now() - openedAt)) / 1000));
          this.emit(socket, { t: 'notice', level: 'warn', code: 'nudge-cooldown', text: `${leftSec}초 뒤에 다시 재촉할 수 있습니다` });
          return;
        }
        const targets = room.members.filter((m) => m.accountId !== room.hostAccountId && !m.ready);
        if (!targets.length) {
          this.emit(socket, { t: 'notice', level: 'info', code: 'nudge-none', text: '재촉할 사람이 없습니다' });
          return;
        }
        await this.state.set(RealtimeGateway.nudgeKey(room.roomId), Date.now(), RealtimeGateway.NUDGE_INTERVAL_MS);
        const host = room.members.find((m) => m.accountId === room.hostAccountId);
        // 대상이 다른 노드에 붙어 있을 수 있다 — 계정 중계로 보낸다
        for (const m of targets) {
          this.toAccount(m.accountId, { t: 'notice', level: 'info', code: 'ready-nudge', text: `${host?.nickname ?? '호스트'}님이 준비를 기다리고 있습니다` });
        }
        this.emit(socket, { t: 'notice', level: 'info', code: 'nudge-sent', text: `${targets.length}명에게 알렸습니다` });
        return;
      }
      case 'rules:update': {
        const before = (await this.rooms.membershipOf(d.accountId))!;
        const wasEligible = this.rooms.eligibility(before).eligible;
        const { room, changes } = await this.rooms.updateRules(d.accountId, { patch: msg.patch as never, followStandardLimit: msg.followStandardLimit });
        if (changes.length) this.toRoom(room.roomId, { t: 'ready:cleared', reason: '호스트가 룰을 변경했습니다', changes });
        void wasEligible;
        this.pushRoom(room); return;
      }
      case 'rules:preset': {
        const { room, changes } = await this.rooms.updateRules(d.accountId, 'preset');
        if (changes.length) this.toRoom(room.roomId, { t: 'ready:cleared', reason: '랭크 판으로 맞췄습니다', changes });
        this.pushRoom(room); return;
      }
      case 'match:start': await this.startMatch(socket, d); return;
      case 'room:leave': await this.leave(socket, d); return;
      case 'room:kick': {
        const room = await this.rooms.kick(d.accountId, msg.accountId);
        if (room.currentMatchId) await this.matches.command(room.roomId, { t: 'kick', accountId: msg.accountId });
        const target = this.sockets.get(msg.accountId);
        if (target) { (target.data as SocketData).roomId = null; this.emit(target, { t: 'room:closed', reason: '호스트가 내보냈습니다' }); }
        await this.afterMembershipChange(room);
        this.pushRoom(room); return;
      }
      case 'host:delegate': { const room = await this.rooms.delegate(d.accountId, msg.accountId); this.pushRoom(room); return; }
      case 'room:close': {
        const roomId = await this.rooms.closeByHost(d.accountId);
        await this.state.del(RealtimeGateway.nudgeKey(roomId));
        this.toRoom(roomId, { t: 'room:closed', reason: '호스트가 룸을 닫았습니다' });
        for (const s of this.server.sockets.sockets.values()) if ((s.data as SocketData)?.roomId === roomId) (s.data as SocketData).roomId = null;
        return;
      }
      case 'room:rematch': {
        const room = await this.rooms.membershipOf(d.accountId);
        if (!room) return;
        const again = await this.rooms.withLock(async () => {
          const fresh = await this.rooms.get(room.roomId);
          if (!fresh) return null;
          if (fresh.hostAccountId !== d.accountId) throw new RoomError('not-host', '호스트만 다시 시작할 수 있습니다');
          fresh.phase = 'waiting';
          fresh.currentMatchEndsAtMs = null;
          for (const m of fresh.members) m.ready = false;   // 룰은 남고 준비는 풀린다(§1.3)
          fresh.leftDuringMatch = [];
          fresh.lastActivityAtMs = Date.now();
          await this.rooms.save(fresh);
          return fresh;
        });
        if (again) this.pushRoom(again); return;
      }
      case 'chat:send': await this.chat(socket, d, msg.text); return;
      case 'lobby:subscribe': this.lobbyWatchers.add(socket.id); await this.pushLobby(true); return;
      case 'lobby:unsubscribe': this.lobbyWatchers.delete(socket.id); return;
    }
  }

  /** 룸 전체에 현재 상태를 보낸다 — HTTP 로 멤버십이 바뀐 뒤에도 이 경로를 쓴다 */
  pushRoom(room: RoomState): void {
    this.toRoom(room.roomId, { t: 'room:state', room: this.rooms.toRoomView(room) });
  }

  /** 진행 중 멤버십이 0이 되면 **먼저 판을 끝낸다**(ROOMLIFE §7.1) */
  private async afterMembershipChange(room: RoomState): Promise<void> {
    if (room.phase !== 'playing' || room.members.length > 0) return;
    await this.matches.command(room.roomId, { t: 'finish', reason: 'membership-empty' });
  }

  private async leave(socket: Socket, d: SocketData): Promise<void> {
    if (d.roomId) await this.matches.command(d.roomId, { t: 'leave', accountId: d.accountId });
    const { room } = await this.rooms.leave(d.accountId);
    (socket.data as SocketData).roomId = null;
    this.emit(socket, { t: 'room:closed', reason: '룸에서 나왔습니다' });
    if (room) { await this.afterMembershipChange(room); this.pushRoom(room); }
  }

  private async chat(socket: Socket, d: SocketData, text: string): Promise<void> {
    const room = await this.rooms.membershipOf(d.accountId);
    if (!room) return;
    const trimmed = text.trim().slice(0, CHAT_MAX_LEN);
    if (!trimmed) return;
    if (!chatOpen({ mode: room.ruleState.rules.mode, rankEligible: this.rooms.eligibility(room).eligible, phase: room.phase })) {
      this.emit(socket, { t: 'notice', level: 'info', code: 'chat-closed', text: '랭크 레이스 판은 진행 중 채팅이 닫힙니다 — 결과 화면에서 다시 열립니다' });
      return;
    }
    if (!d.bucket.take()) {
      this.emit(socket, { t: 'notice', level: 'info', code: 'chat-rate', text: '조금 천천히 보내 주세요' });
      return;
    }
    const message: ChatMessage = {
      id: randomUUID(), kind: 'user', accountId: d.accountId, nickname: d.nickname,
      text: trimmed, atEpochMs: Date.now(),
    };
    this.toRoom(room.roomId, { t: 'chat', message });
  }

  system(roomId: string, text: string): void {
    this.toRoom(roomId, { t: 'chat', message: { id: randomUUID(), kind: 'system', accountId: null, nickname: null, text, atEpochMs: Date.now() } });
  }

  /**
   * 시작은 **잠금 안에서 읽고 잠금 안에서 저장한다.**
   * socket.io 는 핸들러가 끝나기를 기다리지 않으므로, 같은 소켓의 앞 메시지(예: 룰 변경)가
   * 아직 처리 중일 때 이 메시지가 도착한다. 밖에서 읽으면 바뀌기 직전의 룰로 판이 열린다.
   */
  private async startMatch(socket: Socket, d: SocketData): Promise<void> {
    const prepared = await this.rooms.withLock(async () => {
      const room = await this.rooms.membershipOf(d.accountId);
      if (!room) throw new RoomError('no-room', '룸에 없습니다');
      if (room.hostAccountId !== d.accountId) throw new RoomError('not-host', '호스트만 시작할 수 있습니다');

      const ids = room.members.map((m) => m.accountId);
      const rules = room.ruleState.rules;
      const eligible = this.rooms.eligibility(room).eligible;
      const assignable = eligible ? await this.pool.canAssignWithoutFallback(rules.difficulty as Difficulty, ids) : true;

      const blockers = this.rooms.startBlockers(room, eligible ? assignable : null);
      if (blockers.length) return { blocked: true as const, notice: blockers[0]!, code: 'cannot-start' };

      const assignment = await this.pool.assign(rules.difficulty as Difficulty, ids, eligible);
      if (!assignment) return { blocked: true as const, notice: '지금은 이 난이도의 새 퍼즐이 없습니다 — 잠시 뒤 다시 시도하세요', code: 'no-puzzle' };

      const rankEligible = eligible && !assignment.fallback;
      const matchId = `mt_${randomUUID().slice(0, 8)}`;
      room.phase = 'playing';
      room.currentMatchId = matchId;
      // 로비의 남은 시간은 판을 갖지 않은 노드도 그려야 한다 — 룸에 적어 둔다.
      // 실제 판은 몇 밀리초 뒤에 열리므로 그만큼의 오차가 있고, 초 단위 표시에는 묻힌다.
      room.currentMatchEndsAtMs = Date.now() + rules.limitSec * 1000;
      await this.state.del(RealtimeGateway.nudgeKey(room.roomId));   // 재촉은 대기 구간의 장치다
      room.lastActivityAtMs = Date.now();
      await this.rooms.save(room);
      return { blocked: false as const, room, rules, assignment, rankEligible, matchId };
    });

    if (prepared.blocked) {
      this.emit(socket, { t: 'notice', level: 'warn', code: prepared.code, text: prepared.notice });
      return;
    }
    const { room, rules, assignment, rankEligible, matchId } = prepared;

    await this.matches.startMatch({
      matchId, roomId: room.roomId, puzzleId: assignment.puzzle.puzzleId,
      mode: rules.mode, difficulty: rules.difficulty, limitSec: rules.limitSec,
      violationDisplay: rules.violationDisplay, hintsAllowed: rules.hintsAllowed, rankEligible,
      givens: assignment.puzzle.givens, solution: assignment.puzzle.solution,
      path: assignment.puzzle.path as never,
      members: room.members.map((m) => ({ accountId: m.accountId, nickname: m.nickname })),
      nowMs: Date.now(),
    });
    this.pushRoom(room);
    this.system(room.roomId, `판이 시작되었습니다 — ${rankEligible ? '랭킹에 반영됩니다' : '캐주얼 판입니다'}`);
  }

  async pushLobby(full = false): Promise<void> {
    if (this.lobbyWatchers.size === 0) return;
    const rooms = (await this.rooms.listRooms()).filter((r) => r.isPublic);
    const upsert = rooms.map((r) => {
      // 판을 가진 노드가 아니어도 그릴 수 있어야 한다 — 룸에 적힌 값을 본다
      const endsIn = r.currentMatchEndsAtMs === null ? null : Math.max(0, Math.round((r.currentMatchEndsAtMs - Date.now()) / 1000));
      return this.rooms.toLobbyView(r, endsIn);
    });
    for (const s of this.server.sockets.sockets.values()) {
      if (this.lobbyWatchers.has(s.id)) this.emit(s, { t: 'lobby:delta', upsert, remove: [], full });
    }
  }

  startLobbyLoop(): void {
    if (this.lobbyTimer) return;
    this.lobbyTimer = setInterval(() => { void this.pushLobby(); }, LOBBY_PERIOD_MS);
    this.lobbyTimer.unref?.();
  }
  stopLobbyLoop(): void { if (this.lobbyTimer) { clearInterval(this.lobbyTimer); this.lobbyTimer = null; } }
  onModuleDestroy(): void { this.stopLobbyLoop(); }

  /** 룸에 다시 붙이기 — HTTP 로 참가한 뒤 소켓 쪽 상태를 맞춘다 */
  bindRoom(accountId: string, roomId: string | null): void {
    const s = this.sockets.get(accountId);
    if (s) (s.data as SocketData).roomId = roomId;
  }
  pushRoomTo(accountId: string, room: RoomState): void {
    const s = this.sockets.get(accountId);
    if (s) this.emit(s, { t: 'room:state', room: this.rooms.toRoomView(room) });
  }
}
