import { generatePuzzle } from '../src/sudoku/generator.js';
let ok = 0, ms = 0, att = 0;
const S = 3;
for (let s = 0; s < S; s++) {
  const t0 = performance.now();
  const r = generatePuzzle('nightmare', { seed: 500 + s * 104729, maxAttempts: 250 });
  ms += performance.now() - t0; att += r.attempts;
  if (r.puzzle) { ok++; console.log(`  ok  시도 ${r.attempts}회 · ${(performance.now()-t0).toFixed(0)}ms · 단서 ${r.puzzle.clues} · ${r.puzzle.techniques.filter(t=>['Swordfish','XYZ-Wing','Unique Rectangle'].includes(t)).join(',')}`); }
  else console.log(`  실패 (250회) · 폐기 분포`, r.discardedAs);
}
console.log(`\n악몽: ${ok}/${S} 성공 · 평균 ${(ms/S/1000).toFixed(1)}s · 평균 시도 ${(att/S).toFixed(0)}회`);
