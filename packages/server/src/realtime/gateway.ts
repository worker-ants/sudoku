/**
 * socket.io 게이트웨이 — **나가는 메시지의 단일 지점**이다.
 * 여기를 지나지 않고 나가는 페이로드는 없고, 그래서 전송 가드가 자동으로 따라붙는다.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
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

interface SocketData { accountId: string; nickname: string; roomId: string | null; bucket: TokenBucket }

@Injectable()
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
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
  ) {
    this.matches.wire(
      (roomId, msg) => this.toRoom(roomId, msg),
      (accountId, msg) => this.toAccount(accountId, msg),
      async (m, f) => {
        const { ratingDeltas } = await this.ranking.handoff(m, f);
        const room = await this.rooms.get(m.roomId);
        if (room) {
          room.phase = 'result';
          room.currentMatchId = null;
          room.lastResultMatchId = m.matchId;
          room.lastActivityAtMs = Date.now();
          for (const mem of room.members) mem.ready = false;
          await this.rooms.save(room);
        }
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
              wrongSubmits: p.wrongSubmits, violations: p.violations, hintsUsed: p.hintsUsed,
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
  private emit(socket: Socket, msg: ServerMessage, opts: { finalizedMatchId?: string } = {}): void {
    const data = socket.data as SocketData;
    const match = data.roomId ? this.matches.matchOfRoom(data.roomId) : null;
    const finalized = opts.finalizedMatchId !== undefined || match === null || match.finalizedAtEpochMs !== null;
    try {
      assertNoSolutionLeak(msg, { solution: match?.solution, finalized });
    } catch (e) {
      if (e instanceof SolutionLeakError) { this.log.error(`전송 차단 — ${e.message}`); return; }
      throw e;
    }
    socket.emit('msg', msg);
  }
  private toRoom(roomId: string, msg: ServerMessage, opts: { finalizedMatchId?: string } = {}): void {
    for (const s of this.server.sockets.sockets.values()) {
      if ((s.data as SocketData)?.roomId === roomId) this.emit(s, msg, opts);
    }
  }
  private toAccount(accountId: string, msg: ServerMessage): void {
    const s = this.sockets.get(accountId);
    if (s) this.emit(s, msg);
  }

  // ── 연결 ────────────────────────────────────────────────────────────────
  async handleConnection(socket: Socket): Promise<void> {
    const cookie = socket.handshake.headers.cookie ?? '';
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(cookie)?.[1];
    const account = await this.auth.resolveSession(sid ? decodeURIComponent(sid) : undefined);
    if (!account) { socket.disconnect(true); return; }

    // 룸 소켓은 계정당 하나 — 마지막 연결이 이긴다(AREA-ROOM §2.2)
    const prev = this.sockets.get(account.accountId);
    if (prev && prev.id !== socket.id) {
      prev.emit('msg', { t: 'notice', level: 'warn', code: 'replaced', text: '다른 곳에서 접속했습니다' } satisfies ServerMessage);
      prev.disconnect(true);
    }
    this.sockets.set(account.accountId, socket);

    const room = await this.rooms.membershipOf(account.accountId);
    socket.data = { accountId: account.accountId, nickname: account.nickname, roomId: room?.roomId ?? null, bucket: new TokenBucket() } satisfies SocketData;
    if (room) {
      await this.rooms.setConnected(account.accountId, true);
      const fresh = (await this.rooms.get(room.roomId))!;
      this.emit(socket, { t: 'room:state', room: this.rooms.toRoomView(fresh) });
      const m = this.matches.matchOfRoom(room.roomId);
      if (m) {
        await this.matches.handleConnection(m, account.accountId, true);
        this.emit(socket, this.matches.snapshotFor(m, account.accountId));
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
      const m = this.matches.matchOfRoom(room.roomId);
      if (m) await this.matches.handleConnection(m, d.accountId, false);
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

  private async dispatch(socket: Socket, d: SocketData, msg: ClientMessage): Promise<void> {
    const match = d.roomId ? this.matches.matchOfRoom(d.roomId) : null;
    switch (msg.t) {
      case 'cell:set': if (match) await this.matches.handleCell(match, d.accountId, msg.index, msg.value); return;
      case 'cursor:set': if (match) await this.matches.handleCursor(match, d.accountId, msg.index); return;
      case 'submit:request': if (match) await this.matches.handleSubmit(match, d.accountId); return;
      case 'submit:cancel': if (match) await this.matches.handleCancel(match, d.accountId); return;
      case 'hint:request': if (match) await this.matches.handleHint(match, d.accountId); return;
      case 'ready:toggle': { const r = await this.rooms.toggleReady(d.accountId); this.pushRoom(r); return; }
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
        if (match) await this.matches.handleKick(match, msg.accountId);
        const target = this.sockets.get(msg.accountId);
        if (target) { (target.data as SocketData).roomId = null; this.emit(target, { t: 'room:closed', reason: '호스트가 내보냈습니다' }); }
        await this.afterMembershipChange(room);
        this.pushRoom(room); return;
      }
      case 'host:delegate': { const room = await this.rooms.delegate(d.accountId, msg.accountId); this.pushRoom(room); return; }
      case 'room:close': {
        const roomId = await this.rooms.closeByHost(d.accountId);
        this.toRoom(roomId, { t: 'room:closed', reason: '호스트가 룸을 닫았습니다' });
        for (const s of this.server.sockets.sockets.values()) if ((s.data as SocketData)?.roomId === roomId) (s.data as SocketData).roomId = null;
        return;
      }
      case 'room:rematch': {
        const room = await this.rooms.membershipOf(d.accountId);
        if (!room) return;
        if (room.hostAccountId !== d.accountId) throw new RoomError('not-host', '호스트만 다시 시작할 수 있습니다');
        room.phase = 'waiting';
        for (const m of room.members) m.ready = false;     // 룰은 남고 준비는 풀린다(§1.3)
        room.leftDuringMatch = [];
        room.lastActivityAtMs = Date.now();
        await this.rooms.save(room);
        this.pushRoom(room); return;
      }
      case 'chat:send': await this.chat(socket, d, msg.text); return;
      case 'lobby:subscribe': this.lobbyWatchers.add(socket.id); await this.pushLobby(true); return;
      case 'lobby:unsubscribe': this.lobbyWatchers.delete(socket.id); return;
    }
  }

  private pushRoom(room: RoomState): void {
    this.toRoom(room.roomId, { t: 'room:state', room: this.rooms.toRoomView(room) });
  }

  /** 진행 중 멤버십이 0이 되면 **먼저 판을 끝낸다**(ROOMLIFE §7.1) */
  private async afterMembershipChange(room: RoomState): Promise<void> {
    if (room.phase !== 'playing' || room.members.length > 0) return;
    const m = this.matches.matchOfRoom(room.roomId);
    if (m) await this.matches.finish(m, 'membership-empty', Date.now());
  }

  private async leave(socket: Socket, d: SocketData): Promise<void> {
    const match = d.roomId ? this.matches.matchOfRoom(d.roomId) : null;
    if (match) await this.matches.handleLeave(match, d.accountId);
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

  private async startMatch(socket: Socket, d: SocketData): Promise<void> {
    const room = await this.rooms.membershipOf(d.accountId);
    if (!room) throw new RoomError('no-room', '룸에 없습니다');
    if (room.hostAccountId !== d.accountId) throw new RoomError('not-host', '호스트만 시작할 수 있습니다');

    const ids = room.members.map((m) => m.accountId);
    const rules = room.ruleState.rules;
    const eligible = this.rooms.eligibility(room).eligible;
    const assignable = eligible ? await this.pool.canAssignWithoutFallback(rules.difficulty as Difficulty, ids) : true;

    const blockers = this.rooms.startBlockers(room, eligible ? assignable : null);
    if (blockers.length) { this.emit(socket, { t: 'notice', level: 'warn', code: 'cannot-start', text: blockers[0]! }); return; }

    const assignment = await this.pool.assign(rules.difficulty as Difficulty, ids, eligible);
    if (!assignment) { this.emit(socket, { t: 'notice', level: 'warn', code: 'no-puzzle', text: '지금은 이 난이도의 새 퍼즐이 없습니다 — 잠시 뒤 다시 시도하세요' }); return; }

    const rankEligible = eligible && !assignment.fallback;
    const matchId = `mt_${randomUUID().slice(0, 8)}`;
    room.phase = 'playing';
    room.currentMatchId = matchId;
    room.lastActivityAtMs = Date.now();
    await this.rooms.save(room);

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
      const m = this.matches.matchOfRoom(r.roomId);
      const endsIn = m ? Math.max(0, Math.round((m.endsAtEpochMs - Date.now()) / 1000)) : null;
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
