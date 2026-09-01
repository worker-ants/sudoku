import { describe, it, expect } from 'vitest';
import { DEFAULT_RULE_STATE, STANDARD_LIMIT_SEC, applyRuleUpdate, rankPreset, shortLimitNotice } from '../src/rules/rules.js';
import { evaluateEligibility, MIN_PLAYERS } from '../src/rules/eligibility.js';

describe('룰 변경은 원자적이다 (G4)', () => {
  it('여러 항목을 한 번에 바꿔도 변경 목록은 하나로 나온다', () => {
    const r = applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { difficulty: 'expert', capacity: 6 } }, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changes).toHaveLength(3); // 난이도 · 정원 · (표준값 따름으로 제한 시간)
    expect(r.next.rules.limitSec).toBe(STANDARD_LIMIT_SEC.expert);
  });
  it('묶음 중 하나라도 걸리면 전체를 거부한다', () => {
    const r = applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { difficulty: 'expert', capacity: 99 } }, 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes('정원'))).toBe(true);
  });
  it('정원을 현재 인원 아래로 내릴 수 없다', () => {
    const r = applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { capacity: 3 } }, 5);
    expect(r.ok).toBe(false);
  });
});

describe('제한 시간의 두 상태 (G3)', () => {
  it('"표준값 따름"이면 난이도를 따라간다', () => {
    const r = applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { difficulty: 'nightmare' } }, 2);
    expect(r.ok && r.next.rules.limitSec).toBe(STANDARD_LIMIT_SEC.nightmare);
  });
  it('직접 지정하면 난이도가 바뀌어도 유지된다', () => {
    const a = applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { limitSec: 20 * 60 } }, 2);
    expect(a.ok).toBe(true); if (!a.ok) return;
    expect(a.next.followStandardLimit).toBe(false);
    const b = applyRuleUpdate(a.next, { patch: { difficulty: 'expert' } }, 2);
    expect(b.ok && b.next.rules.limitSec).toBe(20 * 60);
  });
  it('1분 단위가 아니면 거부', () => {
    expect(applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { limitSec: 125 } }, 2).ok).toBe(false);
  });
  it('캐주얼 범위는 3~60분 (G2)', () => {
    expect(applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { limitSec: 120 } }, 2).ok).toBe(false);
    expect(applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { limitSec: 61 * 60 } }, 2).ok).toBe(false);
    expect(applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { limitSec: 3 * 60 } }, 2).ok).toBe(true);
  });
  it('짧으면 막지 않고 알린다 (§4.3)', () => {
    const r = applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { difficulty: 'expert', limitSec: 5 * 60 } }, 2);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(shortLimitNotice(r.next.rules)).toContain('미완주');
  });
});

describe('랭크 프리셋 (G1)', () => {
  it('세 항목만 바꾸고 모드·난이도·정원은 건드리지 않는다', () => {
    const state = applyRuleUpdate(DEFAULT_RULE_STATE, { patch: { difficulty: 'hard', capacity: 6, hintsAllowed: true, violationDisplay: 'hide', limitSec: 10 * 60 } }, 2);
    expect(state.ok).toBe(true); if (!state.ok) return;
    const applied = applyRuleUpdate(state.next, rankPreset(state.next), 2);
    expect(applied.ok).toBe(true); if (!applied.ok) return;
    expect(applied.next.rules.difficulty).toBe('hard');
    expect(applied.next.rules.capacity).toBe(6);
    expect(applied.next.rules.hintsAllowed).toBe(false);
    expect(applied.next.rules.violationDisplay).toBe('show');
    expect(applied.next.rules.limitSec).toBe(STANDARD_LIMIT_SEC.hard);
  });
});

describe('랭크 자격 (§2.5)', () => {
  const base = DEFAULT_RULE_STATE.rules;
  it('기본값 조합은 인원 3명이면 랭크 판이다 (G5)', () => {
    expect(evaluateEligibility({ rules: base, memberCount: 3 }).eligible).toBe(true);
  });
  it('레이스 2명이면 캐주얼이고 이유를 이름으로 준다', () => {
    const e = evaluateEligibility({ rules: base, memberCount: 2 });
    expect(e.eligible).toBe(false);
    expect(e.reasons.join()).toContain('최소 3명');
  });
  it('협동 최소 인원은 2명', () => {
    expect(MIN_PLAYERS.coop).toBe(2);
    expect(evaluateEligibility({ rules: { ...base, mode: 'coop' }, memberCount: 2 }).eligible).toBe(true);
  });
  it('힌트·숨김·비표준 제한 시간이 각각 이름으로 걸린다', () => {
    const e = evaluateEligibility({ rules: { ...base, hintsAllowed: true, violationDisplay: 'hide', limitSec: 20 * 60 }, memberCount: 4 });
    expect(e.reasons).toHaveLength(3);
    expect(e.reasons.join()).toMatch(/힌트 허용/);
    expect(e.reasons.join()).toMatch(/숨김/);
    expect(e.reasons.join()).toMatch(/표준 15분/);
  });
  it('퍼즐 배정 불가는 자격 조건이다 (R8)', () => {
    const e = evaluateEligibility({ rules: base, memberCount: 4, puzzleAssignable: false });
    expect(e.eligible).toBe(false);
    expect(e.reasons.join()).toContain('재배정 금지');
  });
  it('실시간 표시에서는 퍼즐 배정을 평가하지 않는다 — 시작 조건 5가 대신 막는다', () => {
    expect(evaluateEligibility({ rules: base, memberCount: 4 }).eligible).toBe(true);
  });
});
