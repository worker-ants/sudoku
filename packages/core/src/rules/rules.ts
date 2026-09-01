/** 룰 항목 여섯 개와 그 검증 (FTR-RULES §1·§2) */
import type { Difficulty } from '../sudoku/solver.js';

export type Mode = 'race' | 'coop';
export type ViolationDisplay = 'show' | 'hide';

export interface Rules {
  mode: Mode;
  difficulty: Difficulty;
  capacity: number;
  limitSec: number;
  violationDisplay: ViolationDisplay;
  hintsAllowed: boolean;
}

/** 난이도별 표준 제한 시간 (PUZZLE §3.2 · U3) */
export const STANDARD_LIMIT_SEC: Record<Difficulty, number> = {
  intro: 8 * 60, normal: 15 * 60, hard: 25 * 60, expert: 30 * 60, nightmare: 40 * 60,
};
/** 1인 완주 중앙값(목표) — 짧은 제한 시간에 안내를 띄우는 기준 */
export const MEDIAN_FINISH_SEC: Record<Difficulty, [number, number]> = {
  intro: [180, 300], normal: [360, 600], hard: [720, 1080], expert: [1200, 1800], nightmare: [1800, 2700],
};
export const CASUAL_LIMIT_MIN_SEC = 3 * 60;
export const CASUAL_LIMIT_MAX_SEC = 60 * 60;
export const CAPACITY_MIN = 2;
export const CAPACITY_MAX = 8;

export const DEFAULT_RULES: Rules = {
  mode: 'race', difficulty: 'normal', capacity: 4,
  limitSec: STANDARD_LIMIT_SEC.normal, violationDisplay: 'show', hintsAllowed: false,
};

export interface RuleState {
  rules: Rules;
  /** 제한 시간의 두 상태 (G3) — 표준값 따름이면 난이도를 따라간다 */
  followStandardLimit: boolean;
}
export const DEFAULT_RULE_STATE: RuleState = { rules: { ...DEFAULT_RULES }, followStandardLimit: true };

export interface RuleUpdate {
  patch: Partial<Rules>;
  followStandardLimit?: boolean;
}
export type RuleValidation = { ok: true; next: RuleState; changes: string[] } | { ok: false; errors: string[] };

const LABEL: Record<keyof Rules, string> = {
  mode: '모드', difficulty: '난이도', capacity: '정원',
  limitSec: '제한 시간', violationDisplay: '제약 위반 표시', hintsAllowed: '힌트 허용',
};
const fmtLimit = (s: number): string => `${Math.round(s / 60)}분`;
const DIFF_LABEL: Record<Difficulty, string> = {
  intro: '입문', normal: '보통', hard: '어려움', expert: '전문가', nightmare: '악몽',
};
const val = (k: keyof Rules, r: Rules): string => {
  if (k === 'limitSec') return fmtLimit(r.limitSec);
  if (k === 'difficulty') return DIFF_LABEL[r.difficulty];
  if (k === 'mode') return r.mode === 'race' ? '레이스' : '협동';
  if (k === 'violationDisplay') return r.violationDisplay === 'show' ? '표시' : '숨김';
  if (k === 'hintsAllowed') return r.hintsAllowed ? '허용' : '비허용';
  return String(r[k]);
};

/**
 * 룰 변경은 원자적이다 (G4).
 * 묶음 중 하나라도 검증에 걸리면 **전체를 거부하고** 현재 룰을 그대로 둔다.
 */
export function applyRuleUpdate(state: RuleState, update: RuleUpdate, currentMembers: number): RuleValidation {
  const next: Rules = { ...state.rules, ...update.patch };
  let follow = update.followStandardLimit ?? state.followStandardLimit;

  // 난이도가 바뀌었고 "표준값 따름" 이면 제한 시간이 함께 간다 (G3)
  const difficultyChanged = update.patch.difficulty !== undefined && update.patch.difficulty !== state.rules.difficulty;
  if (update.patch.limitSec !== undefined && update.patch.limitSec !== state.rules.limitSec) follow = update.followStandardLimit ?? false;
  if (difficultyChanged && follow) next.limitSec = STANDARD_LIMIT_SEC[next.difficulty];
  if (follow && update.patch.limitSec === undefined) next.limitSec = STANDARD_LIMIT_SEC[next.difficulty];

  const errors: string[] = [];
  if (next.mode !== 'race' && next.mode !== 'coop') errors.push('모드 값이 올바르지 않습니다');
  if (!(next.difficulty in STANDARD_LIMIT_SEC)) errors.push('난이도 값이 올바르지 않습니다');
  if (!Number.isInteger(next.capacity) || next.capacity < CAPACITY_MIN || next.capacity > CAPACITY_MAX)
    errors.push(`정원은 ${CAPACITY_MIN}~${CAPACITY_MAX} 사이여야 합니다`);
  if (next.capacity < currentMembers)
    errors.push(`정원을 현재 인원(${currentMembers}명)보다 낮출 수 없습니다 — 먼저 내보내세요`);
  if (!Number.isInteger(next.limitSec) || next.limitSec % 60 !== 0)
    errors.push('제한 시간은 1분 단위입니다');
  if (next.limitSec < CASUAL_LIMIT_MIN_SEC || next.limitSec > CASUAL_LIMIT_MAX_SEC)
    errors.push(`제한 시간은 ${CASUAL_LIMIT_MIN_SEC / 60}~${CASUAL_LIMIT_MAX_SEC / 60}분 사이여야 합니다`);
  if (next.violationDisplay !== 'show' && next.violationDisplay !== 'hide') errors.push('제약 위반 표시 값이 올바르지 않습니다');
  if (typeof next.hintsAllowed !== 'boolean') errors.push('힌트 허용 값이 올바르지 않습니다');
  if (errors.length) return { ok: false, errors };

  const changes: string[] = [];
  for (const k of Object.keys(LABEL) as (keyof Rules)[]) {
    if (state.rules[k] !== next[k]) changes.push(`${LABEL[k]}  ${val(k, state.rules)} → ${val(k, next)}`);
  }
  return { ok: true, next: { rules: next, followStandardLimit: follow }, changes };
}

/** "랭크 판으로 맞추기" (G1) — 제한 시간·제약 위반 표시·힌트 셋만 건드린다 */
export function rankPreset(state: RuleState): RuleUpdate {
  return {
    patch: {
      limitSec: STANDARD_LIMIT_SEC[state.rules.difficulty],
      violationDisplay: 'show',
      hintsAllowed: false,
    },
    followStandardLimit: true,
  };
}

/** 제한 시간이 그 난이도의 완주 중앙값보다 짧으면 막지 않고 알린다 (§4.3) */
export function shortLimitNotice(rules: Rules): string | null {
  const [lo, hi] = MEDIAN_FINISH_SEC[rules.difficulty];
  if (rules.limitSec >= lo) return null;
  return `${DIFF_LABEL[rules.difficulty]} 난이도의 완주 중앙값은 ${Math.round(lo / 60)}~${Math.round(hi / 60)}분입니다. 대부분 미완주로 끝날 수 있습니다.`;
}
