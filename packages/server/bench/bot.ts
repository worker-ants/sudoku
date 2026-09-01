/**
 * 사람이 브라우저에서 플레이하는 동안 상대 자리를 채우는 스크립트.
 * 서버에는 사람과 구분되지 않는다 — 입력이 회신 없는 단방향 스트림이기 때문이다.
 */
import { io } from 'socket.io-client';
import type { ClientMessage, ServerMessage } from '@sudoku/contracts';
import { solveBruteForce } from '@sudoku/core';

const ORIGIN = process.env['ORIGIN'] ?? 'http://localhost:4000';
const CODE = process.argv[2];
const NICK = process.argv[3] ?? 'Bot';
const READY = process.argv[4] !== 'noready';
// 'solve' 를 주면 판이 시작된 뒤 실제로 풀어서 제출한다. 뒤의 수는 한 칸당 입력 간격(ms)이다.
const SOLVE = process.argv.includes('solve');
const PACE = Number(process.argv[process.argv.indexOf('solve') + 1] ?? 60) || 60;
if (!CODE) { console.error('사용법: bot.ts <ROOMCODE> <닉네임> [noready] [solve <ms>]'); process.exit(1); }

const post = async (path: string, body: unknown, cookie?: string) => {
  const res = await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
};

const email = `${NICK.toLowerCase()}@bot.example.com`;
let r = await post('/api/auth/signup', { email, nickname: NICK, password: 'password123' });
if (!r.res.ok) r = await post('/api/auth/login', { email, password: 'password123' });
const cookie = (r.res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
if (!cookie) { console.error('로그인 실패', r.json); process.exit(1); }

const j = await post('/api/rooms/join', { code: CODE }, cookie);
if (!j.res.ok) { console.error('참가 실패', j.json); process.exit(1); }
console.log(`${NICK} 참가함`);

const socket = io(ORIGIN, { transports: ['websocket'], extraHeaders: { cookie }, forceNew: true });
const send = (m: ClientMessage): void => { socket.emit('msg', m); };
socket.on('connect', () => { if (READY) setTimeout(() => send({ t: 'ready:toggle' }), 500); });

socket.on('msg', (m: ServerMessage) => {
  if (m.t === 'match:started') {
    console.log(`${NICK}: 판 시작 — ${m.match.difficulty} ${m.match.rankEligible ? '(랭크)' : '(캐주얼)'}`);
    if (SOLVE) void play(m.match.givens);
  }
  // 진행 중인 판에 다시 붙으면 시작 알림 대신 스냅샷이 온다.
  if (m.t === 'match:snapshot' && SOLVE && !m.finished) {
    console.log(`${NICK}: 진행 중인 판에 합류`);
    void play(m.match.givens, m.cells);
  }
  if (m.t === 'match:ended') {
    const me = m.result.participants.find((p) => p.nickname === NICK);
    console.log(`${NICK}: 판 끝 — ${m.result.endReason} · 순위 ${me?.rank ?? '-'} · 정답 ${me?.correctCells ?? 0}칸`);
  }
  if (m.t === 'notice') console.log(`${NICK}: [${m.code}] ${m.text}`);
  if (m.t === 'chat' && m.message.kind === 'user') console.log(`${NICK} 들음 — ${m.message.nickname}: ${m.message.text}`);
});
let playing = false;

/** 사람처럼 한 칸씩 채우고 마지막에 제출한다 — 정답은 단서에서 직접 푼다. */
async function play(givens: readonly number[], filled?: readonly number[]): Promise<void> {
  if (playing) return;
  playing = true;
  const solution = solveBruteForce(givens);
  if (!solution) { console.error(`${NICK}: 풀이 실패`); return; }
  const blanks = solution.map((_, i) => i).filter((i) => givens[i] === 0 && solution[i] !== filled?.[i]);
  for (const i of blanks) {
    send({ t: 'cell:set', index: i, value: solution[i]! });
    await new Promise((r) => setTimeout(r, PACE));
  }
  send({ t: 'submit:request' });
  console.log(`${NICK}: 제출함 (${blanks.length}칸)`);
}

console.log(`${NICK} 대기 중`);
