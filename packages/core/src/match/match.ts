/**
 * 판 상태 기계 (AREA-PLAY · RACE · COOP)
 *
 * 전부 순수 함수다 — 서버가 시계와 저장소를 붙여 구동한다.
 * **정답은 이 상태 안에만 있고 전송 타입으로 나가지 않는다**(ADR-STACK S4).
 */
import { blankCount, filledCount, violations, isFull } from '../sudoku/grid.js';
import { nextHint, type SolveStep } from '../sudoku/solver.js';
import type { Difficulty } from '../sudoku/solver.js';
import type { Mode, ViolationDisplay } from '../rules/rules.js';
import {
  HINT_LIMIT, SUBMIT_LIMIT, adjustedFinishSec, gatePassed, judge, requiredContribution,
  teamPoint, totalPenaltySec, type Judgeable,
} from '../scoring/scoring.js';

export type EndReason = 'all-finished' | 'time-expired' | 'membership-empty';

export interface ParticipantState {
  accountId: string; nickname: string; colorIndex: number;
  cells: number[];              // 레이스는 개인 보드, 협동은 팀 보드를 가리키지 않고 비워 둔다
  submitsUsed: number; hintsUsed: number; violations: number;
  finished: boolean; finishElapsedSec: number | null;
  left: boolean; kicked: boolean; connected: boolean;
  cursor: number | null;
}

export interface SubmitWindowState {
  byAccountId: string; openedAtMs: number; endsAtMs: number; snapshot: number[];
}

export interface TeamState {
  cells: number[];
  submitsUsed: number; hintsUsed: number;
  finished: boolean; finishElapsedSec: number | null;
  /** 칸마다 `값 → 최초 입력자` — 칸당 최대 9개로 유계다(COOP §7.1) */
  firstEntry: Map<number, Map<number, string>>;
  /** 칸당 최근 20개 (COOP §7.1) */
  changeLog: Map<number, { value: number; by: string; atMs: number }[]>;
  window: SubmitWindowState | null;
  cooldownUntilMs: number;
  seq: number;
}

export interface MatchState {
  matchId: string; roomId: string; puzzleId: string;
  mode: Mode; difficulty: Difficulty; limitSec: number;
  violationDisplay: ViolationDisplay; hintsAllowed: boolean; rankEligible: boolean;
  givens: number[]; solution: number[]; path: SolveStep[];
  startedAtEpochMs: number; endsAtEpochMs: number;
  finalizedAtEpochMs: number | null; endReason: EndReason | null;
  participants: Map<string, ParticipantState>;
  startingMembers: string[];
  team: TeamState | null;
}

export interface CreateMatchInput {
  matchId: string; roomId: string; puzzleId: string;
  mode: Mode; difficulty: Difficulty; limitSec: number;
  violationDisplay: ViolationDisplay; hintsAllowed: boolean; rankEligible: boolean;
  givens: number[]; solution: number[]; path: SolveStep[];
  members: { accountId: string; nickname: string }[];
  nowMs: number;
}

export function createMatch(i: CreateMatchInput): MatchState {
  const participants = new Map<string, ParticipantState>();
  i.members.forEach((m, idx) => {
    participants.set(m.accountId, {
      accountId: m.accountId, nickname: m.nickname, colorIndex: idx,
      cells: i.mode === 'race' ? [...i.givens] : [],
      submitsUsed: 0, hintsUsed: 0, violations: 0,
      finished: false, finishElapsedSec: null,
      left: false, kicked: false, connected: true, cursor: null,
    });
  });
  return {
    ...i,
    startedAtEpochMs: i.nowMs,
    endsAtEpochMs: i.nowMs + i.limitSec * 1000,
    finalizedAtEpochMs: null, endReason: null,
    participants,
    startingMembers: i.members.map((m) => m.accountId),
    team: i.mode === 'coop'
      ? {
          cells: [...i.givens], submitsUsed: 0, hintsUsed: 0,
          finished: false, finishElapsedSec: null,
          firstEntry: new Map(), changeLog: new Map(),
          window: null, cooldownUntilMs: 0, seq: 0,
        }
      : null,
  };
}

export const elapsedSec = (m: MatchState, nowMs: number): number =>
  Math.max(0, Math.round((nowMs - m.startedAtEpochMs) / 1000));
export const boardOf = (m: MatchState, accountId: string): number[] =>
  m.mode === 'coop' ? m.team!.cells : (m.participants.get(accountId)?.cells ?? []);

const canInput = (m: MatchState, p: ParticipantState, nowMs: number): string | null => {
  if (m.finalizedAtEpochMs !== null) return 'match-ended';
  if (nowMs >= m.endsAtEpochMs) return 'time-expired';
  if (p.left || p.kicked) return 'left';
  if (p.finished) return 'already-finished';
  if (m.mode === 'coop') {
    if (m.team!.finished) return 'already-finished';
    // 취소 창이 열려 있는 동안 도착한 입력은 **서버가 버린다** (COOP O7)
    if (m.team!.window && nowMs < m.team!.window.endsAtMs) return 'submit-window-open';
  }
  return null;
};

export interface CellChange { index: number; value: number; by: string; seq: number }

/** 셀 입력 — 서버는 회신하지 않는다. 협동에서만 중계용 변경을 돌려준다 */
export function setCell(
  m: MatchState, accountId: string, index: number, value: number, nowMs: number,
): { ok: boolean; reason?: string; change?: CellChange } {
  const p = m.participants.get(accountId);
  if (!p) return { ok: false, reason: 'not-participant' };
  const blocked = canInput(m, p, nowMs);
  if (blocked) return { ok: false, reason: blocked };
  if (index < 0 || index > 80 || m.givens[index]) return { ok: false, reason: 'not-editable' };
  if (!Number.isInteger(value) || value < 0 || value > 9) return { ok: false, reason: 'bad-value' };

  const board = m.mode === 'coop' ? m.team!.cells : p.cells;
  board[index] = value;

  if (value > 0 && violations(board).has(index)) p.violations++;

  if (m.mode === 'coop') {
    const t = m.team!;
    if (value > 0) {
      const per = t.firstEntry.get(index) ?? t.firstEntry.set(index, new Map()).get(index)!;
      if (!per.has(value)) per.set(value, accountId);   // 최초 입력자만 남긴다
    }
    const log = t.changeLog.get(index) ?? t.changeLog.set(index, []).get(index)!;
    log.push({ value, by: accountId, atMs: nowMs });
    if (log.length > 20) log.shift();                   // 칸당 최근 20개
    const seq = ++t.seq;
    return { ok: true, change: { index, value, by: accountId, seq } };
  }
  return { ok: true };
}

export function setCursor(m: MatchState, accountId: string, index: number | null): void {
  const p = m.participants.get(accountId);
  if (p) p.cursor = index;
}

/** 제출 가능 조건 — 모든 빈칸이 채워졌고 제약 위반이 하나도 없어야 한다 */
export function submitBlockedReason(m: MatchState, accountId: string): string | null {
  const board = boardOf(m, accountId);
  if (!isFull(board)) return 'incomplete';
  if (violations(board).size > 0) return 'violation';
  const used = m.mode === 'coop' ? m.team!.submitsUsed : (m.participants.get(accountId)?.submitsUsed ?? 0);
  if (used >= SUBMIT_LIMIT) return 'submit-limit';
  return null;
}

export interface SubmitOutcome {
  passed: boolean; wrongCount: number | null;
  submitsUsed: number; penaltySecTotal: number; finishedAtElapsedSec: number | null;
}

function scoreSubmit(m: MatchState, board: number[]): number {
  let wrong = 0;
  for (let i = 0; i < 81; i++) if (board[i] !== m.solution[i]) wrong++;
  return wrong;
}

/** 레이스: 개인 제출. 협동은 requestSubmit → fireSubmit 경로를 쓴다 */
export function submitRace(m: MatchState, accountId: string, nowMs: number): { ok: boolean; reason?: string; outcome?: SubmitOutcome } {
  const p = m.participants.get(accountId);
  if (!p) return { ok: false, reason: 'not-participant' };
  const blocked = canInput(m, p, nowMs) ?? submitBlockedReason(m, accountId);
  if (blocked) return { ok: false, reason: blocked };

  const wrong = scoreSubmit(m, p.cells);
  if (wrong === 0) {
    p.finished = true;
    p.finishElapsedSec = elapsedSec(m, nowMs);
    return { ok: true, outcome: {
      passed: true, wrongCount: null, submitsUsed: p.submitsUsed,
      penaltySecTotal: totalPenaltySec(p.submitsUsed),
      finishedAtElapsedSec: adjustedFinishSec(p.finishElapsedSec, p.submitsUsed),
    } };
  }
  p.submitsUsed++;
  return { ok: true, outcome: {
    passed: false, wrongCount: wrong, submitsUsed: p.submitsUsed,
    penaltySecTotal: totalPenaltySec(p.submitsUsed), finishedAtElapsedSec: null,
  } };
}

export const SUBMIT_WINDOW_MS = 5000;
export const SUBMIT_COOLDOWN_MS = 10000;

/** 협동 — 5초 취소 창을 연다. 스냅샷·타이머·입력 잠금 전부 서버가 갖는다(O7) */
export function requestTeamSubmit(m: MatchState, accountId: string, nowMs: number): { ok: boolean; reason?: string; endsAtMs?: number; isLast?: boolean } {
  const p = m.participants.get(accountId);
  if (!p || m.mode !== 'coop') return { ok: false, reason: 'not-coop' };
  const t = m.team!;
  if (m.finalizedAtEpochMs !== null || t.finished) return { ok: false, reason: 'match-ended' };
  if (t.window && nowMs < t.window.endsAtMs) return { ok: false, reason: 'window-open' };
  if (nowMs < t.cooldownUntilMs) return { ok: false, reason: 'cooldown' };
  const blocked = submitBlockedReason(m, accountId);
  if (blocked) return { ok: false, reason: blocked };
  t.window = { byAccountId: accountId, openedAtMs: nowMs, endsAtMs: nowMs + SUBMIT_WINDOW_MS, snapshot: [...t.cells] };
  return { ok: true, endsAtMs: t.window.endsAtMs, isLast: t.submitsUsed === SUBMIT_LIMIT - 1 };
}

export function cancelTeamSubmit(m: MatchState, accountId: string, nowMs: number): { ok: boolean; reason?: string } {
  if (m.mode !== 'coop') return { ok: false, reason: 'not-coop' };
  const t = m.team!;
  if (!t.window || nowMs >= t.window.endsAtMs) return { ok: false, reason: 'no-window' };
  const p = m.participants.get(accountId);
  if (!p || p.left || p.kicked || !p.connected) return { ok: false, reason: 'not-eligible' };
  t.window = null;
  t.cooldownUntilMs = nowMs + SUBMIT_COOLDOWN_MS;   // 팀 전체 10초 쿨다운
  return { ok: true };
}

/** 창이 끝나면 **누른 순간의 스냅샷**을 채점한다 */
export function fireTeamSubmit(m: MatchState, nowMs: number): { fired: boolean; outcome?: SubmitOutcome } {
  if (m.mode !== 'coop') return { fired: false };
  const t = m.team!;
  if (!t.window || nowMs < t.window.endsAtMs) return { fired: false };
  const snapshot = t.window.snapshot;
  t.window = null;
  const wrong = scoreSubmit(m, snapshot);
  if (wrong === 0) {
    t.finished = true;
    t.finishElapsedSec = elapsedSec(m, nowMs);
    t.cells = snapshot;
    for (const p of m.participants.values()) { p.finished = true; p.finishElapsedSec = t.finishElapsedSec; }
    return { fired: true, outcome: {
      passed: true, wrongCount: null, submitsUsed: t.submitsUsed,
      penaltySecTotal: totalPenaltySec(t.submitsUsed),
      finishedAtElapsedSec: adjustedFinishSec(t.finishElapsedSec, t.submitsUsed),
    } };
  }
  t.submitsUsed++;
  return { fired: true, outcome: {
    passed: false, wrongCount: wrong, submitsUsed: t.submitsUsed,
    penaltySecTotal: totalPenaltySec(t.submitsUsed), finishedAtElapsedSec: null,
  } };
}

/** 힌트 — 위치와 기법 이름만. 빈칸이 없으면 null 이고 횟수도 소모하지 않는다 */
export function requestHint(m: MatchState, accountId: string, nowMs: number): { ok: boolean; reason?: string; index?: number; technique?: string; used?: number } {
  const p = m.participants.get(accountId);
  if (!p) return { ok: false, reason: 'not-participant' };
  if (!m.hintsAllowed) return { ok: false, reason: 'hints-not-allowed' };
  const blocked = canInput(m, p, nowMs);
  if (blocked) return { ok: false, reason: blocked };
  const used = m.mode === 'coop' ? m.team!.hintsUsed : p.hintsUsed;
  if (used >= HINT_LIMIT) return { ok: false, reason: 'hint-limit' };

  const board = boardOf(m, accountId);
  const h = nextHint(m.path, board);
  if (!h) return { ok: false, reason: 'board-full' };   // 버튼이 비활성이어야 하는 상태

  if (m.mode === 'coop') m.team!.hintsUsed++; else p.hintsUsed++;
  p.hintsUsed = m.mode === 'coop' ? p.hintsUsed : p.hintsUsed;
  return { ok: true, index: h.index, technique: h.technique, used: m.mode === 'coop' ? m.team!.hintsUsed : p.hintsUsed };
}

export function markLeft(m: MatchState, accountId: string): void {
  const p = m.participants.get(accountId);
  if (p) { p.left = true; p.connected = false; }
}
export function markKicked(m: MatchState, accountId: string): void {
  const p = m.participants.get(accountId);
  if (p) { p.kicked = true; p.left = true; p.connected = false; }
}
export function setConnected(m: MatchState, accountId: string, connected: boolean): void {
  const p = m.participants.get(accountId);
  if (p && !p.left) p.connected = connected;
}

/** 남은 참가자가 없는가 — 진행 중 멤버십 0이면 판을 끝낸다(ROOMLIFE §7.1) */
export const membershipEmpty = (m: MatchState): boolean =>
  [...m.participants.values()].every((p) => p.left || p.kicked);

export const allFinished = (m: MatchState): boolean =>
  m.mode === 'coop'
    ? m.team!.finished
    : [...m.participants.values()].every((p) => p.finished || p.left || p.kicked);

export function dueEndReason(m: MatchState, nowMs: number): EndReason | null {
  if (m.finalizedAtEpochMs !== null) return null;
  // 아무도 남지 않았으면 사유는 '전원 완주'가 아니라 '멤버십 0' 이다 —
  // 남은 사람이 없어서 끝나는 것과 다 풀어서 끝나는 것은 다른 사건이다.
  if (membershipEmpty(m)) return 'membership-empty';
  if (allFinished(m)) return 'all-finished';
  if (nowMs >= m.endsAtEpochMs) return 'time-expired';
  return null;
}

export interface FinalizedParticipant {
  accountId: string; nickname: string;
  finished: boolean; adjustedFinishSec: number | null;
  correctCells: number; wrongSubmits: number; violations: number; hintsUsed: number;
  rank: number; rankPoint: number; left: boolean; kicked: boolean;
  contribution?: number; gatePassed?: boolean; requiredContribution?: number;
  cells: number[];
}
export interface FinalizedMatch {
  matchId: string; endReason: EndReason; rankEligible: boolean; limitSec: number;
  participants: FinalizedParticipant[];
  team?: { finished: boolean; adjustedFinishSec: number | null; teamPoint: number; hintsUsed: number; filledCells: number };
  solution: number[];
}

/**
 * 판 확정 — 서버가 보관 중인 상태를 그대로 굳히고 채점한다(§5.1).
 * `atEpochMs` 는 **종료 시각**이다. 다운타임을 지나 늦게 발견해도 발견 시각이 아니라
 * 종료 시각으로 채점해야 기록 랭킹이 서버 장애에 오염되지 않는다(AREA-PLAY §4.1).
 */
export function finalizeMatch(m: MatchState, reason: EndReason, atEpochMs: number): FinalizedMatch {
  m.finalizedAtEpochMs = atEpochMs;
  m.endReason = reason;
  const limitElapsed = m.limitSec;
  const blanks = blankCount(m.givens);

  const correctOf = (board: number[]): number => {
    let n = 0;
    for (let i = 0; i < 81; i++) if (!m.givens[i] && board[i] === m.solution[i]) n++;
    return n;
  };

  // 제출하지 않은 완성 보드는 완주로 인정하되 완주 시각은 만료 시각으로 본다(§5.1)
  for (const p of m.participants.values()) {
    if (p.finished || p.left || p.kicked) continue;
    const board = boardOf(m, p.accountId);
    if (isFull(board) && correctOf(board) === blanks) {
      p.finished = true;
      p.finishElapsedSec = limitElapsed;
      if (m.mode === 'coop' && !m.team!.finished) {
        m.team!.finished = true; m.team!.finishElapsedSec = limitElapsed;
      }
    }
  }
  if (m.mode === 'coop' && m.team!.finished) {
    for (const p of m.participants.values()) if (!p.left && !p.kicked) { p.finished = true; p.finishElapsedSec = m.team!.finishElapsedSec; }
  }

  const teamFilled = m.mode === 'coop' ? filledCount(m.team!.cells, m.givens) : 0;
  const required = requiredContribution(teamFilled, m.startingMembers.length);

  // 협동 기여도 — 정답인 칸마다 그 값을 최초로 입력한 사람(COOP §8.1)
  const contribution = new Map<string, number>();
  if (m.mode === 'coop') {
    for (const id of m.startingMembers) contribution.set(id, 0);
    for (let i = 0; i < 81; i++) {
      if (m.givens[i]) continue;
      if (m.team!.cells[i] !== m.solution[i]) continue;
      const who = m.team!.firstEntry.get(i)?.get(m.solution[i]!);
      if (who) contribution.set(who, (contribution.get(who) ?? 0) + 1);
    }
  }

  const judgeable: Judgeable[] = [...m.participants.values()].map((p) => {
    const board = boardOf(m, p.accountId);
    const wrongSubmits = m.mode === 'coop' ? m.team!.submitsUsed : p.submitsUsed;
    return {
      accountId: p.accountId,
      finished: p.finished,
      adjustedFinishSec: p.finished && p.finishElapsedSec !== null ? adjustedFinishSec(p.finishElapsedSec, wrongSubmits) : null,
      correctCells: correctOf(board),
      wrongSubmits,
      hintsUsed: m.mode === 'coop' ? m.team!.hintsUsed : p.hintsUsed,
    };
  });
  const judged = judge(judgeable);

  const participants: FinalizedParticipant[] = judged.map((j) => {
    const p = m.participants.get(j.accountId)!;
    const base: FinalizedParticipant = {
      accountId: p.accountId, nickname: p.nickname,
      finished: j.finished, adjustedFinishSec: j.adjustedFinishSec,
      correctCells: j.correctCells, wrongSubmits: j.wrongSubmits,
      violations: p.violations, hintsUsed: j.hintsUsed,
      rank: m.mode === 'coop' ? 0 : j.rank,
      rankPoint: m.mode === 'coop' ? 0 : j.rankPoint,
      left: p.left, kicked: p.kicked,
      cells: [...boardOf(m, p.accountId)],
    };
    if (m.mode === 'coop') {
      const c = contribution.get(p.accountId) ?? 0;
      base.contribution = c;
      base.requiredContribution = required;
      base.gatePassed = gatePassed(c, teamFilled, m.startingMembers.length);
    }
    return base;
  });

  const out: FinalizedMatch = {
    matchId: m.matchId, endReason: reason, rankEligible: m.rankEligible,
    limitSec: m.limitSec, participants, solution: [...m.solution],
  };
  if (m.mode === 'coop') {
    const t = m.team!;
    const adj = t.finished && t.finishElapsedSec !== null ? adjustedFinishSec(t.finishElapsedSec, t.submitsUsed) : null;
    out.team = {
      finished: t.finished, adjustedFinishSec: adj, hintsUsed: t.hintsUsed, filledCells: teamFilled,
      teamPoint: teamPoint({
        finished: t.finished, adjustedFinishSec: adj, limitSec: m.limitSec,
        correctCells: participants[0]?.correctCells ?? 0, blankCells: blanks,
      }),
    };
  }
  return out;
}
