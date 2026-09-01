import { describe, it, expect } from 'vitest';
import { assertNoSolutionLeak, SolutionLeakError } from '../src/realtime/emit-guard.js';
import type { ServerMessage } from '@sudoku/contracts';

const solution = Array.from({ length: 81 }, (_, i) => (i % 9) + 1);

describe('런타임 전송 가드 (ADR-STACK §4.3)', () => {
  it('평범한 메시지는 통과한다', () => {
    const msg: ServerMessage = { t: 'notice', level: 'info', code: 'x', text: '안녕' };
    expect(() => assertNoSolutionLeak(msg, { solution, finalized: false })).not.toThrow();
  });

  it('배열로 실린 정답을 잡는다', () => {
    const msg = { t: 'match:snapshot', cells: solution } as unknown as ServerMessage;
    expect(() => assertNoSolutionLeak(msg, { solution, finalized: false })).toThrow(SolutionLeakError);
  });

  it('깊이 묻어도 잡는다', () => {
    const msg = { t: 'progress', progress: { deep: { deeper: [{ leak: solution }] } } } as unknown as ServerMessage;
    expect(() => assertNoSolutionLeak(msg, { solution, finalized: false })).toThrow(SolutionLeakError);
  });

  it('문자열로 이어 붙여도 잡는다', () => {
    const msg = { t: 'chat', message: { text: `정답은 ${solution.join('')}` } } as unknown as ServerMessage;
    expect(() => assertNoSolutionLeak(msg, { solution, finalized: false })).toThrow(SolutionLeakError);
  });

  it('원본 단서는 정답이 아니므로 통과한다', () => {
    const givens = solution.map((v, i) => (i % 3 === 0 ? v : 0));
    const msg = { t: 'match:started', match: { givens } } as unknown as ServerMessage;
    expect(() => assertNoSolutionLeak(msg, { solution, finalized: false })).not.toThrow();
  });

  it('match:ended 는 판이 확정된 뒤에만 나갈 수 있다 — 예외가 아니라 선행 조건이다', () => {
    const msg = { t: 'match:ended', result: { solutionRevealed: solution } } as unknown as ServerMessage;
    expect(() => assertNoSolutionLeak(msg, { solution, finalized: false })).toThrow(SolutionLeakError);
    expect(() => assertNoSolutionLeak(msg, { solution, finalized: true })).not.toThrow();
  });

  it('판이 없으면 검사할 정답도 없다', () => {
    const msg: ServerMessage = { t: 'notice', level: 'info', code: 'x', text: 'y' };
    expect(() => assertNoSolutionLeak(msg, { finalized: true })).not.toThrow();
  });
});
