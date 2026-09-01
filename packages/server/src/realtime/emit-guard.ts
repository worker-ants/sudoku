/**
 * S0 의 런타임 절반 — **단일 emit 지점에서 모든 나가는 페이로드를 본다.**
 *
 * 정적 검사(tools/transport-guard.mjs)가 타입의 모양을 보는 동안 이쪽은 실제 값을 본다.
 * 새 메시지를 추가해도 emit 를 거치는 한 검사가 자동으로 따라붙는다 — ADR-STACK §8이
 * "새 엔드포인트를 추가할 때 검사가 자동으로 따라붙는지"를 가정으로 남긴 자리가 여기다.
 *
 * 규칙은 시간에 걸린 것이다(VISION §9):
 *   판이 도는 동안 정답 정보가 클라이언트로 나가는 통로는 제출 채점의 "틀린 칸 수" 하나뿐.
 * 그래서 예외 목록이 아니라 **선행 조건**으로 쓴다 — `match:ended` 는 확정된 뒤에만 나갈 수 있다.
 */
import type { ServerMessage } from '@sudoku/contracts';

export class SolutionLeakError extends Error {
  constructor(message: string) { super(message); this.name = 'SolutionLeakError'; }
}

export interface EmitContext {
  /** 이 소켓이 속한 판의 정답. 판이 없으면 undefined */
  solution?: readonly number[];
  /** 그 판이 확정되었는가 */
  finalized: boolean;
}

const arraysEqual = (a: readonly number[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function scan(value: unknown, solution: readonly number[], path: string): string | null {
  if (Array.isArray(value)) {
    if (value.length === solution.length && arraysEqual(solution, value)) return path;
    for (let i = 0; i < value.length; i++) {
      const hit = scan(value[i], solution, `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const hit = scan(v, solution, `${path}.${k}`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'string' && value.length >= solution.length && value.includes(solution.join(''))) return path;
  return null;
}

/** 나가기 직전에 부른다. 위반이면 던진다 — 조용히 넘어가지 않는다 */
export function assertNoSolutionLeak(msg: ServerMessage, ctx: EmitContext): void {
  if (msg.t === 'match:ended') {
    if (!ctx.finalized) {
      throw new SolutionLeakError('판이 확정되기 전에 match:ended 를 내보내려 했다 — 정답 공개는 결과 화면의 것이다');
    }
    return;
  }
  if (!ctx.solution || ctx.solution.length === 0) return;
  const hit = scan(msg, ctx.solution, msg.t);
  if (hit) {
    throw new SolutionLeakError(`판이 도는 동안 정답이 전송 페이로드에 실렸다 — ${hit}`);
  }
}
