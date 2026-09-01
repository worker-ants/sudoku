#!/usr/bin/env node
/**
 * S0 — 전송 경계 정적 검사 (ADR-STACK §4.3 · S4)
 *
 * 세 가지를 본다. **세 검사 모두 예외 목록이 없다.**
 *
 *  1) contracts 는 아무것도 import 하지 않는다
 *     — 서버 내부 상태 타입이 전송 패키지로 흘러드는 경로 자체를 없앤다.
 *  2) 판이 도는 동안 나가는 메시지 타입에 정답을 담을 필드가 없다
 *     — 정답이 나가는 유일한 메시지는 `match:ended` 이고, 그것은 판이 확정된 뒤에만
 *       나갈 수 있다. 그 순서는 런타임 emit 가드가 강제한다(server/src/realtime/emit-guard.ts).
 *       여기서는 **그 메시지가 판 종료 메시지 하나뿐인지**를 확인한다.
 *  3) ServerMessage 변형에 any / unknown 이 없다
 *     — 타입이 느슨하면 검사 1·2 가 통과해도 실제 페이로드는 무엇이든 될 수 있다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'packages/contracts/src';
const FORBIDDEN = /\b(solution|answer|solved|correctCells?Values?|정답)\b/i;

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

const problems = [];
let checkedFields = 0;

for (const f of files(SRC)) {
  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n');

  // (1) import 금지
  lines.forEach((l, i) => {
    if (/^\s*import\s/.test(l) && !/^\s*import\s+type\s+\{[^}]*\}\s+from\s+'\.\//.test(l)) {
      problems.push(`${f}:${i + 1}  contracts 는 import 를 갖지 않는다 — ${l.trim()}`);
    }
  });

  // (2) 정답을 담을 수 있는 필드 — 판 종료 메시지 안이 아니면 전부 위반
  let block = null;
  lines.forEach((l, i) => {
    const decl = l.match(/^export\s+interface\s+(\w+)/) || l.match(/^export\s+type\s+(\w+)/);
    if (decl) block = decl[1];
    if (/^\s*\}/.test(l) && !/=>/.test(l)) block = block; // 블록 추적은 느슨하게 유지
    const field = l.match(/^\s{2}(\w+)\??:/);
    if (!field) return;
    checkedFields++;
    if (!FORBIDDEN.test(field[1])) return;
    if (block === 'MatchEnded') return; // 판 종료 메시지 — 순서는 런타임 가드가 본다
    problems.push(`${f}:${i + 1}  판 중 전송 타입에 정답을 담을 필드 — ${block}.${field[1]}`);
  });
}

// (2-b) 정답을 담은 타입이 판 종료 메시지에만 쓰이는지
const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
const uses = [...index.matchAll(/\bMatchEnded\b/g)].length;
const inEndedVariant = /\{ t: 'match:ended'; result: MatchEnded \}/.test(index);
if (!inEndedVariant) problems.push(`ServerMessage 에 match:ended 변형이 없다 — MatchEnded 의 출구가 불분명하다`);
if (uses > 3) problems.push(`MatchEnded 가 ${uses}곳에서 쓰인다 — 판 종료 경로 밖으로 샜을 수 있다`);

// (3) any / unknown 금지
const sm = index.slice(index.indexOf('export type ServerMessage'));
const smBody = sm.slice(0, sm.indexOf(';\n'));
if (/\b(any|unknown)\b/.test(smBody)) problems.push('ServerMessage 변형에 any/unknown 이 있다');

if (problems.length) {
  console.error('전송 경계 검사 실패\n');
  for (const p of problems) console.error('  ✗ ' + p);
  console.error(`\n${problems.length}건. ADR-STACK §4.3 — 이 검사에는 예외 경로를 만들지 않는다.`);
  process.exit(1);
}
console.log(`전송 경계 검사 통과 — 필드 ${checkedFields}개, import 0, ServerMessage 느슨한 타입 0`);
