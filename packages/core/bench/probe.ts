import { generatePuzzle } from '../src/sudoku/generator.js';
import { countSolutions, violations, isFull } from '../src/sudoku/grid.js';

const pz = generatePuzzle('normal', { seed: 4242, maxAttempts: 80 }).puzzle!;
console.log('유일해 개수(상한 3):', countSolutions(pz.givens, 3));
console.log('');
console.log('주장: 원본 단서가 고정된 채로 "빈칸이 전부 차고 제약 위반이 0" 인 보드는');
console.log('      행·열·박스마다 1~9 가 정확히 한 번씩 = 유효한 완성 스도쿠다.');
console.log('      퍼즐의 해가 유일하므로 그 보드는 정답과 같을 수밖에 없다.');
console.log('');
// 반례를 찾아본다 — 정답에서 두 칸을 바꿔 위반 0 을 만들 수 있나
let counterexample = 0, tried = 0;
const blanks = pz.givens.map((v,i)=> v?-1:i).filter(i=>i>=0);
for (const x of blanks) for (const y of blanks) {
  if (x>=y) continue;
  if (pz.solution[x] === pz.solution[y]) continue;   // 같은 값 맞바꾸기는 보드가 그대로다
  const b = [...pz.solution];
  [b[x], b[y]] = [b[y]!, b[x]!];
  tried++;
  if (isFull(b) && violations(b).size === 0) counterexample++;
}
console.log(`정답에서 두 칸 맞바꾸기 ${tried}가지 중 위반 0 인 보드: ${counterexample}개`);
console.log('');
console.log('→ 서버의 제출 게이트(빈칸 0 + 위반 0)를 통과하는 보드는 항상 정답이다.');
console.log('→ N1(틀린 칸 수 회신) · N2(상한 5회 · +30n초)가 닿지 않는 규칙이 된다.');
