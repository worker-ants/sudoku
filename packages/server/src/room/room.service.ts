/**
 * 로비 · 룸 · 생명주기 (AREA-ROOM · ROOMLIFE · READY · RULES · CHAT)
 *
 * 원칙 1("한 사람은 한 번에 한 룸")을 **룸 참가 한 곳에서** 강제한다(L4).
 */
import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_RULE_STATE, applyRuleUpdate, evaluateEligibility, rankPreset,
  type RuleState, type Rules,
} from '@sudoku/core';
import type { LobbyRoomView, MemberView, RoomView } from '@sudoku/contracts';
import { CONFIG } from '../config.js';
import type { StateStore } from '../storage/ports.js';
import { KeyedMutex } from './keyed-mutex.js';

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // 0 O 1 I L 제외 (L2)
export const generateRoomCode = (rand = Math.random): string =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)]!).join('');

export type RoomPhase = 'waiting' | 'playing' | 'result';

export interface RoomMember {
  accountId: string; nickname: string; ready: boolean; connected: boolean;
  joinedAtMs: number; colorIndex: number; disconnectedAtMs: number | null;
}
export interface RoomState {
  roomId: string; code: string; name: string; isPublic: boolean;
  hostAccountId: string; phase: RoomPhase;
  ruleState: RuleState; members: RoomMember[];
  currentMatchId: string | null; lastResultMatchId: string | null;
  banned: string[]; createdAtMs: number; lastActivityAtMs: number;
  /** 진행 중 나갔거나 강퇴당한 사람 — 그 판에 다시 들어올 수 없다 */
  leftDuringMatch: string[];
}

export class RoomError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

const roomKey = (id: string) => `room:${id}`;
const codeKey = (code: string) => `roomcode:${code.toUpperCase()}`;
const membershipKey = (accountId: string) => `membership:${accountId}`;

@Injectable()
export class RoomService {
  /** 룸 하나의 읽고-고쳐-쓰기를 직렬화한다 — keyed-mutex.ts 에 이유가 있다. */
  private readonly lock = new KeyedMutex();

  constructor(@Inject('StateStore') private readonly state: StateStore) {}

  /**
   * 룸 변경을 한 줄로 세운다.
   *
   * 키를 룸별로 쪼개는 편이 조밀하지만, 룸을 옮기는 연산(참가)이 **두 룸**을 건드리므로
   * 잠금 순서와 재진입을 함께 다뤄야 한다. v1 은 서버 프로세스가 하나이고 룸 변경은
   * Redis 왕복 몇 번이라, 전역 한 줄이 더 싸고 확실히 옳다. 조밀하게 나눌 자리는 여기다.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T> { return this.lock.run('rooms', fn); }

  async get(roomId: string): Promise<RoomState | null> { return this.state.get<RoomState>(roomKey(roomId)); }
  async save(room: RoomState): Promise<void> { await this.state.set(roomKey(room.roomId), room); }
  async byCode(code: string): Promise<RoomState | null> {
    const id = await this.state.get<string>(codeKey(code));
    return id ? this.get(id) : null;
  }
  async membershipOf(accountId: string): Promise<RoomState | null> {
    const id = await this.state.get<string>(membershipKey(accountId));
    return id ? this.get(id) : null;
  }
  async listRooms(): Promise<RoomState[]> {
    const keys = await this.state.keys('room:');
    const out: RoomState[] = [];
    for (const k of keys) { const r = await this.state.get<RoomState>(k); if (r) out.push(r); }
    return out;
  }

  create(account: { accountId: string; nickname: string }, opts: { name?: string; isPublic?: boolean } = {}): Promise<RoomState> {
    return this.withLock(() => this._create(account, opts));
  }
  private async _create(account: { accountId: string; nickname: string }, opts: { name?: string; isPublic?: boolean } = {}): Promise<RoomState> {
    await this.assertCanJoinElsewhere(account.accountId);
    let code = generateRoomCode();
    for (let i = 0; i < 20 && (await this.state.get<string>(codeKey(code))); i++) code = generateRoomCode();
    const now = Date.now();
    const room: RoomState = {
      roomId: `rm_${randomUUID().slice(0, 8)}`, code,
      name: opts.name?.trim() || `${account.nickname}의 방`,
      isPublic: opts.isPublic ?? true,
      hostAccountId: account.accountId, phase: 'waiting',
      ruleState: { rules: { ...DEFAULT_RULE_STATE.rules }, followStandardLimit: true },
      members: [{ accountId: account.accountId, nickname: account.nickname, ready: false, connected: true, joinedAtMs: now, colorIndex: 0, disconnectedAtMs: null }],
      currentMatchId: null, lastResultMatchId: null, banned: [],
      createdAtMs: now, lastActivityAtMs: now, leftDuringMatch: [],
    };
    await this.save(room);
    await this.state.set(codeKey(code), room.roomId);
    await this.state.set(membershipKey(account.accountId), room.roomId);
    return room;
  }

  /** 원칙 1 — 진행 중인 판이 있으면 **거부**한다(L4) */
  private async assertCanJoinElsewhere(accountId: string): Promise<void> {
    const cur = await this.membershipOf(accountId);
    if (!cur) return;
    if (cur.phase === 'playing') {
      throw new RoomError('in-match', '진행 중인 판이 있습니다 — 그 룸으로 돌아가 나가기를 누르세요');
    }
    await this._leave(accountId, { silent: true });   // 이미 잠금 안이다 — 다시 잡으면 교착한다
  }

  join(account: { accountId: string; nickname: string }, code: string): Promise<RoomState> {
    return this.withLock(() => this._join(account, code));
  }
  private async _join(account: { accountId: string; nickname: string }, code: string): Promise<RoomState> {
    const room = await this.byCode(code);
    if (!room) throw new RoomError('no-room', '그런 룸이 없습니다');
    if (room.banned.includes(account.accountId)) throw new RoomError('banned', '이 룸에 다시 들어올 수 없습니다');
    if (room.members.some((m) => m.accountId === account.accountId)) return room;
    if (room.phase === 'playing') throw new RoomError('playing', '진행 중인 룸에는 들어갈 수 없습니다');
    if (room.members.length >= room.ruleState.rules.capacity) throw new RoomError('full', '정원이 찼습니다');
    await this.assertCanJoinElsewhere(account.accountId);

    const used = new Set(room.members.map((m) => m.colorIndex));
    let colorIndex = 0; while (used.has(colorIndex)) colorIndex++;
    room.members.push({ accountId: account.accountId, nickname: account.nickname, ready: false, connected: true, joinedAtMs: Date.now(), colorIndex, disconnectedAtMs: null });
    room.lastActivityAtMs = Date.now();
    await this.save(room);
    await this.state.set(membershipKey(account.accountId), room.roomId);
    return room;
  }

  /** 나가기 — 멤버십 즉시 해제. 진행 중이면 되돌릴 수 없다(H4·H8) */
  leave(accountId: string, opts: { silent?: boolean } = {}): Promise<{ room: RoomState | null; wasPlaying: boolean }> {
    return this.withLock(() => this._leave(accountId, opts));
  }
  private async _leave(accountId: string, opts: { silent?: boolean } = {}): Promise<{ room: RoomState | null; wasPlaying: boolean }> {
    const room = await this.membershipOf(accountId);
    if (!room) return { room: null, wasPlaying: false };
    const wasPlaying = room.phase === 'playing';
    room.members = room.members.filter((m) => m.accountId !== accountId);
    if (wasPlaying && !room.leftDuringMatch.includes(accountId)) room.leftDuringMatch.push(accountId);
    room.lastActivityAtMs = Date.now();
    await this.state.del(membershipKey(accountId));
    if (room.members.length > 0 && room.hostAccountId === accountId) this.delegateHost(room);
    await this.save(room);
    void opts;
    return { room, wasPlaying };
  }

  /** 호스트 자동 위임 — 참가 순서가 가장 이른 사람 (H1) */
  private delegateHost(room: RoomState): void {
    const next = [...room.members].sort((a, b) => a.joinedAtMs - b.joinedAtMs)[0];
    if (next) room.hostAccountId = next.accountId;
  }

  kick(hostAccountId: string, targetId: string): Promise<RoomState> {
    return this.withLock(() => this._kick(hostAccountId, targetId));
  }
  private async _kick(hostAccountId: string, targetId: string): Promise<RoomState> {
    const room = await this.membershipOf(hostAccountId);
    if (!room) throw new RoomError('no-room', '룸에 없습니다');
    if (room.hostAccountId !== hostAccountId) throw new RoomError('not-host', '호스트만 내보낼 수 있습니다');
    if (targetId === hostAccountId) throw new RoomError('self', '자기 자신은 내보낼 수 없습니다');
    if (!room.members.some((m) => m.accountId === targetId)) throw new RoomError('no-member', '그런 참가자가 없습니다');
    room.members = room.members.filter((m) => m.accountId !== targetId);
    if (!room.banned.includes(targetId)) room.banned.push(targetId);          // 룸 단위 차단 목록(H5)
    if (room.phase === 'playing' && !room.leftDuringMatch.includes(targetId)) room.leftDuringMatch.push(targetId);
    room.lastActivityAtMs = Date.now();
    await this.state.del(membershipKey(targetId));
    await this.save(room);
    return room;
  }

  delegate(hostAccountId: string, targetId: string): Promise<RoomState> {
    return this.withLock(() => this._delegate(hostAccountId, targetId));
  }
  private async _delegate(hostAccountId: string, targetId: string): Promise<RoomState> {
    const room = await this.membershipOf(hostAccountId);
    if (!room) throw new RoomError('no-room', '룸에 없습니다');
    if (room.hostAccountId !== hostAccountId) throw new RoomError('not-host', '호스트만 넘길 수 있습니다');
    if (!room.members.some((m) => m.accountId === targetId)) throw new RoomError('no-member', '그런 참가자가 없습니다');
    room.hostAccountId = targetId;
    room.lastActivityAtMs = Date.now();
    await this.save(room);
    return room;
  }

  /** 연결 끊김 — 대기·결과는 60초 유예 뒤 자동 퇴장, 진행 중에는 자리를 지킨다(H3) */
  setConnected(accountId: string, connected: boolean): Promise<RoomState | null> {
    return this.withLock(() => this._setConnected(accountId, connected));
  }
  private async _setConnected(accountId: string, connected: boolean): Promise<RoomState | null> {
    const room = await this.membershipOf(accountId);
    if (!room) return null;
    const m = room.members.find((x) => x.accountId === accountId);
    if (!m) return null;
    m.connected = connected;
    m.disconnectedAtMs = connected ? null : Date.now();
    await this.save(room);
    return room;
  }

  /** 유예를 넘긴 사람을 정리한다. 진행 중에는 아무도 빼지 않는다 */
  async sweepDisconnected(now = Date.now()): Promise<{ removed: { roomId: string; accountId: string }[] }> {
    const removed: { roomId: string; accountId: string }[] = [];
    for (const room of await this.listRooms()) {
      if (room.phase === 'playing') continue;
      const gone = room.members.filter((m) => !m.connected && m.disconnectedAtMs !== null && now - m.disconnectedAtMs > CONFIG.disconnectGraceMs);
      for (const g of gone) {
        room.members = room.members.filter((m) => m.accountId !== g.accountId);
        await this.state.del(membershipKey(g.accountId));
        removed.push({ roomId: room.roomId, accountId: g.accountId });
      }
      if (gone.length) {
        if (room.members.length && !room.members.some((m) => m.accountId === room.hostAccountId)) this.delegateHost(room);
        await this.save(room);
      }
    }
    return { removed };
  }

  /**
   * 룸의 소멸 (§7)
   *  - 빈 룸(멤버십 0) — **대기·결과 상태에서 평가한다**. 즉시 닫는다
   *  - 유휴 30분 — 대기·결과에서 아무 활동 없음
   *  - 진행 중 — 닫지 않는다. 멤버십이 0이 되면 먼저 판을 끝낸다(§7.1)
   */
  async sweepRooms(now = Date.now()): Promise<{ closed: string[]; emptyDuringMatch: string[] }> {
    const closed: string[] = [];
    const emptyDuringMatch: string[] = [];
    for (const room of await this.listRooms()) {
      if (room.members.length === 0) {
        if (room.phase === 'playing') { emptyDuringMatch.push(room.roomId); continue; }
        await this.destroy(room); closed.push(room.roomId); continue;
      }
      if (room.phase !== 'playing' && now - room.lastActivityAtMs > CONFIG.idleRoomMs) {
        for (const m of room.members) await this.state.del(membershipKey(m.accountId));
        await this.destroy(room); closed.push(room.roomId);
      }
    }
    return { closed, emptyDuringMatch };
  }

  async destroy(room: RoomState): Promise<void> {
    for (const m of room.members) await this.state.del(membershipKey(m.accountId));
    await this.state.del(roomKey(room.roomId));
    await this.state.del(codeKey(room.code));   // 코드 회수 — 재사용은 24시간 뒤부터(L2)
    await this.state.set(`roomcode-reserved:${room.code}`, Date.now());
  }

  closeByHost(hostAccountId: string): Promise<string> {
    return this.withLock(() => this._closeByHost(hostAccountId));
  }
  private async _closeByHost(hostAccountId: string): Promise<string> {
    const room = await this.membershipOf(hostAccountId);
    if (!room) throw new RoomError('no-room', '룸에 없습니다');
    if (room.hostAccountId !== hostAccountId) throw new RoomError('not-host', '호스트만 닫을 수 있습니다');
    if (room.phase === 'playing') throw new RoomError('playing', '진행 중에는 룸을 닫을 수 없습니다');
    await this.destroy(room);
    return room.roomId;
  }

  // ── 룰과 준비 ────────────────────────────────────────────────────────────
  updateRules(hostAccountId: string, update: { patch: Partial<Rules>; followStandardLimit?: boolean } | 'preset'): Promise<{ room: RoomState; changes: string[] }> {
    return this.withLock(() => this._updateRules(hostAccountId, update));
  }
  private async _updateRules(hostAccountId: string, update: { patch: Partial<Rules>; followStandardLimit?: boolean } | 'preset'): Promise<{ room: RoomState; changes: string[] }> {
    const room = await this.membershipOf(hostAccountId);
    if (!room) throw new RoomError('no-room', '룸에 없습니다');
    if (room.hostAccountId !== hostAccountId) throw new RoomError('not-host', '호스트만 룰을 바꿀 수 있습니다');
    if (room.phase === 'playing') throw new RoomError('playing', '진행 중에는 룰이 잠깁니다');
    const u = update === 'preset' ? rankPreset(room.ruleState) : update;
    const r = applyRuleUpdate(room.ruleState, u, room.members.length);
    if (!r.ok) throw new RoomError('invalid-rules', r.errors.join(' · '));
    const before = this.eligibility(room).eligible;
    room.ruleState = r.next;
    room.lastActivityAtMs = Date.now();
    if (r.changes.length) for (const m of room.members) m.ready = false;   // 예외 없이 전원 해제(§3.1)
    void before;
    await this.save(room);
    return { room, changes: r.changes };
  }

  toggleReady(accountId: string): Promise<RoomState> {
    return this.withLock(() => this._toggleReady(accountId));
  }
  private async _toggleReady(accountId: string): Promise<RoomState> {
    const room = await this.membershipOf(accountId);
    if (!room) throw new RoomError('no-room', '룸에 없습니다');
    if (room.phase !== 'waiting') throw new RoomError('not-waiting', '대기 중에만 준비할 수 있습니다');
    if (accountId === room.hostAccountId) throw new RoomError('host-no-ready', '호스트에게는 준비가 없습니다 — 시작 버튼이 의사표시입니다');
    const m = room.members.find((x) => x.accountId === accountId);
    if (!m) throw new RoomError('no-member', '참가자가 아닙니다');
    m.ready = !m.ready;
    room.lastActivityAtMs = Date.now();
    await this.save(room);
    return room;
  }

  /** 인원 변동으로 랭크 자격이 뒤집히면 전원 준비 해제 (Y3) */
  /** 잠금 안에서 **다시 읽어** 판단한다 — 밖에서 들고 온 스냅샷을 저장하면 남의 수정을 덮는다. */
  reconcileEligibility(roomId: string, wasEligible: boolean): Promise<boolean> {
    return this.withLock(async () => {
      const room = await this.get(roomId);
      if (!room) return false;
      const now = this.eligibility(room).eligible;
      if (now !== wasEligible && room.phase === 'waiting') {
        for (const m of room.members) m.ready = false;
        await this.save(room);
        return true;
      }
      return false;
    });
  }

  eligibility(room: RoomState, puzzleAssignable?: boolean) {
    return evaluateEligibility({ rules: room.ruleState.rules, memberCount: room.members.length, puzzleAssignable });
  }

  /**
   * 시작 조건 넷 (READY §2). 마지막 하나는 서버에서만 알 수 있다.
   *
   * 인원 하한은 없다 — 혼자서도 시작한다. 랭크가 새지 않는 것은 여기가 아니라
   * 랭크 자격이 막는다(MIN_PLAYERS 레이스 3 · 협동 2). 1인 판은 정의상 캐주얼이라
   * 레이팅·시즌·기록 어디에도 오르지 않는다.
   */
  startBlockers(room: RoomState, puzzleAssignable: boolean | null): string[] {
    const out: string[] = [];
    if (room.phase !== 'waiting') out.push('대기 중에만 시작할 수 있습니다');
    const notReady = room.members.filter((m) => m.accountId !== room.hostAccountId && !m.ready);
    if (notReady.length) out.push(`${notReady.map((m) => m.nickname).join(', ')}님이 준비하지 않았습니다`);
    if (room.members.length > room.ruleState.rules.capacity) out.push('정원을 넘었습니다');
    if (puzzleAssignable === false && this.eligibility(room).eligible) {
      out.push('지금은 이 난이도의 새 퍼즐이 없습니다 — 잠시 뒤 다시 시도하거나 룰을 바꾸세요');
    }
    return out;
  }

  // ── 뷰 ──────────────────────────────────────────────────────────────────
  toRoomView(room: RoomState): RoomView {
    const members: MemberView[] = room.members.map((m) => ({
      accountId: m.accountId, nickname: m.nickname, isHost: m.accountId === room.hostAccountId,
      ready: m.ready, connected: m.connected, colorIndex: m.colorIndex,
    }));
    const e = this.eligibility(room);
    return {
      roomId: room.roomId, code: room.code, name: room.name, phase: room.phase,
      isPublic: room.isPublic, rules: room.ruleState.rules, members,
      eligibility: { eligible: e.eligible, reasons: e.reasons },
      lastResultMatchId: room.lastResultMatchId,
    };
  }
  toLobbyView(room: RoomState, endsInSec: number | null = null): LobbyRoomView {
    const host = room.members.find((m) => m.accountId === room.hostAccountId);
    return {
      roomId: room.roomId, code: room.code, name: room.name,
      hostNickname: host?.nickname ?? '—',
      mode: room.ruleState.rules.mode, difficulty: room.ruleState.rules.difficulty,
      limitSec: room.ruleState.rules.limitSec,
      count: room.members.length, capacity: room.ruleState.rules.capacity,
      rankEligible: this.eligibility(room).eligible, phase: room.phase, endsInSec,
    };
  }
}
