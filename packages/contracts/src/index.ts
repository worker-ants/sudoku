/**
 * 전송 타입만 두는 패키지 — ADR-STACK S4.
 *
 * **서버 내부 상태 객체를 여기에 두지 않는다.** 이 패키지의 타입은 전부 와이어를 건너가는
 * 모양이고, 정답을 담을 수 있는 필드가 하나도 없다. 그 사실이 타입 수준의 방어이며,
 * 런타임 방어는 서버의 단일 emit 지점이 한다(server/src/realtime/emit-guard.ts).
 *
 * 금지어(solution / answer / solved / 정답)는 tools/transport-guard.mjs 가 정적으로 훑는다.
 */

// ── 공통 ───────────────────────────────────────────────────────────────────
export type Mode = 'race' | 'coop';
export type Difficulty = 'intro' | 'normal' | 'hard' | 'expert' | 'nightmare';
export type RoomPhase = 'waiting' | 'playing' | 'result';
/** 제약 위반 표시 — 오답 표시가 아니다(RULES §5) */
export type ViolationDisplay = 'show' | 'hide';

export interface Rules {
  mode: Mode;
  difficulty: Difficulty;
  capacity: number;          // 2~8
  limitSec: number;          // 180~3600
  violationDisplay: ViolationDisplay;
  hintsAllowed: boolean;
}

/** 랭크 자격 판정 결과 — 어긋난 항목을 이름으로 준다(AREA-ROOM §7) */
export interface RankEligibility {
  eligible: boolean;
  reasons: string[];
}

export interface MemberView {
  accountId: string;
  nickname: string;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  colorIndex: number;
}

export interface RoomView {
  roomId: string;
  code: string;
  name: string;
  phase: RoomPhase;
  isPublic: boolean;
  rules: Rules;
  members: MemberView[];
  eligibility: RankEligibility;
  lastResultMatchId: string | null;
}

export interface LobbyRoomView {
  roomId: string;
  code: string;
  name: string;
  hostNickname: string;
  mode: Mode;
  difficulty: Difficulty;
  limitSec: number;
  count: number;
  capacity: number;
  rankEligible: boolean;
  phase: RoomPhase;
  endsInSec: number | null;
}

// ── 판 ─────────────────────────────────────────────────────────────────────
/**
 * 판 시작 페이로드. **`givens` 는 원본 단서뿐이고 빈칸은 0 이다.**
 * 정답 배열은 존재하지 않으며, 이 타입에 그것을 담을 자리도 없다.
 */
export interface MatchStarted {
  matchId: string;
  mode: Mode;
  difficulty: Difficulty;
  limitSec: number;
  endsAtEpochMs: number;
  serverNowEpochMs: number;
  givens: number[];          // 81칸, 0 = 빈칸
  hintsAllowed: boolean;
  violationDisplay: ViolationDisplay;
  rankEligible: boolean;
  participants: { accountId: string; nickname: string; colorIndex: number }[];
}

/** 레이스: 참가자별. 협동: 팀 단위 하나 + 참가자별 커서(AREA-PLAY §2.1.1) */
export interface ProgressRace {
  kind: 'race';
  atEpochMs: number;
  participants: {
    accountId: string;
    filled: number;          // 채운 칸 수 — 제약 위반을 가리지 않고 센다(RACE §4.2)
    wrongSubmits: number;
    finished: boolean;
    connected: boolean;
    left: boolean;
  }[];
}
export interface ProgressCoop {
  kind: 'coop';
  atEpochMs: number;
  team: { filled: number; wrongSubmits: number; finished: boolean };
  cursors: { accountId: string; index: number | null }[];
  members: { accountId: string; connected: boolean; left: boolean }[];
}
export type Progress = ProgressRace | ProgressCoop;

/** 협동 셀 변경 중계 — 사람이 넣은 값만 옮긴다(COOP §3) */
export interface CellRelay {
  atEpochMs: number;
  changes: { index: number; value: number; byAccountId: string; seq: number }[];
}

export interface SubmitResult {
  passed: boolean;
  /** 불일치 시 **틀린 칸 수만**(N1). 위치도 영역도 주지 않는다 */
  wrongCount: number | null;
  submitsUsed: number;
  submitsLimit: number;
  penaltySecTotal: number;
  finishedAtElapsedSec: number | null;
}

/** 협동 5초 취소 창 — 서버가 소유한다(COOP O7) */
export interface SubmitWindow {
  state: 'open' | 'cancelled' | 'fired';
  byAccountId: string;
  byNickname: string;
  cancelledByNickname?: string;
  endsAtEpochMs: number;
  isLastSubmit: boolean;
  cooldownUntilEpochMs?: number;
}

/** 힌트 — 위치와 기법 이름만. **값 필드가 없다**(P3 절대 규칙) */
export interface HintResult {
  index: number;
  technique: string;
  used: number;
  limit: number;
}

export interface ParticipantResult {
  accountId: string;
  nickname: string;
  finished: boolean;
  adjustedFinishSec: number | null;  // 판 시작 기준 경과 초(D8)
  correctCells: number;
  wrongSubmits: number;
  violations: number;
  hintsUsed: number;
  rank: number;
  rankPoint: number;
  left: boolean;
  kicked: boolean;
  ratingDelta: number | null;
  contribution?: number;
  gatePassed?: boolean;
  requiredContribution?: number;
}

export interface MatchEnded {
  matchId: string;
  mode: Mode;
  endReason: 'all-finished' | 'time-expired' | 'membership-empty';
  rankEligible: boolean;
  limitSec: number;
  /** 결과 화면에서만 공개한다(RACE E3). 판이 도는 동안에는 이 메시지가 나가지 않는다 */
  solutionRevealed: number[];
  boards: { accountId: string; cells: number[] }[];
  participants: ParticipantResult[];
  team?: { finished: boolean; adjustedFinishSec: number | null; teamPoint: number; hintsUsed: number };
}

export interface ChatMessage {
  id: string;
  kind: 'user' | 'system';
  accountId: string | null;
  nickname: string | null;
  text: string;
  atEpochMs: number;
}

// ── 클라이언트 → 서버 ──────────────────────────────────────────────────────
export type ClientMessage =
  | { t: 'cell:set'; index: number; value: number }        // value 0 = 지우기
  | { t: 'cursor:set'; index: number | null }
  | { t: 'submit:request' }
  | { t: 'submit:cancel' }
  | { t: 'hint:request' }
  | { t: 'chat:send'; text: string }
  | { t: 'ready:toggle' }
  | { t: 'rules:update'; patch: Partial<Rules>; followStandardLimit?: boolean }
  | { t: 'rules:preset' }
  | { t: 'match:start' }
  | { t: 'room:leave' }
  | { t: 'room:kick'; accountId: string }
  | { t: 'host:delegate'; accountId: string }
  | { t: 'room:close' }
  | { t: 'room:rematch' }
  | { t: 'lobby:subscribe' }
  | { t: 'lobby:unsubscribe' };

// ── 서버 → 클라이언트 ──────────────────────────────────────────────────────
export type ServerMessage =
  | { t: 'room:state'; room: RoomView }
  | { t: 'room:closed'; reason: string }
  | { t: 'match:started'; match: MatchStarted }
  | { t: 'match:snapshot'; match: MatchStarted; cells: number[]; submitsUsed: number; penaltySecTotal: number; hintsUsed: number; finished: boolean }
  | { t: 'progress'; progress: Progress }
  | { t: 'cells'; relay: CellRelay }
  | { t: 'submit:result'; result: SubmitResult }
  | { t: 'submit:window'; window: SubmitWindow }
  | { t: 'hint:result'; hint: HintResult }
  | { t: 'match:ended'; result: MatchEnded }
  | { t: 'chat'; message: ChatMessage }
  | { t: 'lobby:delta'; upsert: LobbyRoomView[]; remove: string[]; full: boolean }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; code: string; text: string }
  | { t: 'ready:cleared'; reason: string; changes: string[] };

export const SUBMIT_LIMIT = 5;
export const HINT_LIMIT = 3;
export const PROGRESS_PERIOD_MS = 500;   // P1 제안값
export const CELL_RELAY_PERIOD_MS = 100; // P1 제안값
export const LOBBY_PERIOD_MS = 1000;
export const SUBMIT_WINDOW_MS = 5000;
export const SUBMIT_COOLDOWN_MS = 10000;
