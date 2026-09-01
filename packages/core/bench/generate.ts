import { generatePuzzle } from '../src/sudoku/generator.js';
import type { Difficulty } from '../src/sudoku/solver.js';

const SAMPLES = Number(process.env.SAMPLES ?? 5);
const targets: Difficulty[] = ['intro', 'normal', 'hard', 'expert', 'nightmare'];
console.log(`등급별 ${SAMPLES}개 생성 — 폐기율과 소요 시간\n`);
console.log('등급        성공/시도   평균 ms   평균 폐기   평균 단서   기법');
for (const t of targets) {
  let ok = 0, ms = 0, attempts = 0, clues = 0;
  const techs = new Set<string>();
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    const r = generatePuzzle(t, { seed: 1000 + s * 7919, maxAttempts: 40 });
    ms += performance.now() - t0;
    attempts += r.attempts;
    if (r.puzzle) { ok++; clues += r.puzzle.clues; r.puzzle.techniques.forEach((x) => techs.add(x)); }
  }
  const top = [...techs].slice(-3).join(', ');
  console.log(
    `${t.padEnd(11)} ${String(ok).padStart(2)}/${String(SAMPLES).padEnd(6)} ${(ms / SAMPLES).toFixed(0).padStart(7)}  ${(attempts / SAMPLES).toFixed(1).padStart(9)}  ${(ok ? clues / ok : 0).toFixed(1).padStart(9)}   ${top}`,
  );
}
