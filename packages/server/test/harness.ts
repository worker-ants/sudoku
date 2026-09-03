import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { ClientMessage, ServerMessage } from '@sudoku/contracts';
import { generatePuzzle, type Difficulty } from '@sudoku/core';
import { AppModule } from '../src/app.module.js';
import { setDataDir, setSchema } from '../src/runtime-config.js';
import { MatchService } from '../src/match/match.service.js';
import { RealtimeGateway } from '../src/realtime/gateway.js';
import { RoomService } from '../src/room/room.service.js';
import type { ResultStore, StateStore } from '../src/storage/ports.js';
import { CONFIG } from '../src/config.js';

export interface Harness {
  app: INestApplication; url: string; dir: string;
  db: ResultStore; matches: MatchService; rooms: RoomService; gateway: RealtimeGateway;
  seedPuzzle(difficulty: Difficulty, seed?: number): Promise<{ givens: number[]; solution: number[]; puzzleId: string }>;
  stop(keepDir?: boolean): Promise<void>;
}

/**
 * 룸 잠금이 빌 때까지 기다린다.
 *
 * `app.close()` 는 **소켓 종료 처리를 기다리지 않는다.** 소켓이 닫히면 게이트웨이의
 * handleDisconnect 가 룸 잠금 뒤에서 상태 저장소를 읽는데, 그 사이에 저장소를 닫으면
 * ioredis 가 "Connection is closed" 로 터진다 — 시험은 통과하면서 unhandled rejection 만
 * 쌓이는 종류다.
 *
 * 고정 sleep 대신 잠금이 실제로 비었는지 본다. **연속 두 번** 비어야 끝내는 이유는,
 * 아직 시작도 안 한 핸들러가 있으면 첫 관측이 0 으로 나오기 때문이다.
 */
async function settleRooms(rooms: RoomService, timeoutMs = 3000): Promise<void> {
  const lock = (rooms as unknown as { lock: { size: number } }).lock;
  const until = Date.now() + timeoutMs;
  let idle = 0;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10));
    idle = lock.size === 0 ? idle + 1 : 0;
    if (idle >= 2) return;
  }
}

export async function startHarness(reuseDir?: string): Promise<Harness> {
  const dir = reuseDir ?? mkdtempSync(join(tmpdir(), 'sudoku-e2e-'));
  setDataDir(dir);
  // DATABASE_URL 로 진짜 Postgres 에 붙는 경우, 하네스마다 제 스키마를 쓴다.
  // 디렉터리에서 이름을 뽑으므로 재개(reuseDir)하면 같은 스키마로 돌아온다 — 복구 시험이 그것에 기댄다.
  setSchema(`t_${dir.split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9]/g, '_')}`);
  const app = await NestFactory.create(AppModule, { logger: false, cors: { origin: true, credentials: true } });
  await app.listen(0);
  const url = await app.getUrl();
  const db = app.get<ResultStore>('ResultStore');
  const state = app.get<StateStore>('StateStore');
  return {
    app, url: url.replace('[::1]', '127.0.0.1'), dir, db,
    matches: app.get(MatchService), rooms: app.get(RoomService), gateway: app.get(RealtimeGateway),
    async seedPuzzle(difficulty, seed) {
      const r = generatePuzzle(difficulty, { seed: seed ?? 20260901, maxAttempts: 400 });
      const p = r.puzzle!;
      await db.addPuzzle({
        puzzleId: p.puzzleId, difficulty, seed: p.seed, givens: p.givens,
        solution: p.solution, path: p.path, clues: p.clues, createdAtEpochMs: p.createdAtEpochMs,
      });
      return { givens: p.givens, solution: p.solution, puzzleId: p.puzzleId };
    },
    /**
     * 하네스를 접는다.
     *
     * `keepDir` 는 **프로세스가 죽는 시늉**이다 — 재기동 복구 시험이 같은 자리로 돌아와야
     * 하므로 남긴 상태와 격리 설정을 지우지 않는다. 그래도 **연결은 닫는다**: 죽은
     * 프로세스는 소켓을 들고 있지 않고, 두 저장소 모두 Nest 종료 훅이 없어 app.close()
     * 로는 닫히지 않는다(app.module.ts 의 useFactory 두 개).
     */
    async stop(keepDir = false) {
      await app.close();                 // 타이머부터 세운다 — 지운 자리를 두드리면 안 된다
      await settleRooms(app.get(RoomService));

      if (!keepDir) {
        // 남긴 상태를 지운다. 파일 어댑터는 아래 rmSync 로 통째 사라지지만 **Redis 에는
        // 그런 것이 없어**, 지우지 않으면 이 하네스의 이름공간이 서버에 그대로 쌓인다.
        // rmSync 의 대응물이 여기다.
        if (CONFIG.redisUrl) for (const k of await state.keys('')) await state.del(k);
        // 스키마 삭제는 풀을 닫기 전에 — 닫은 뒤에 부르면 풀을 다시 여는 꼴이 된다
        const d = db as unknown as { db?: { dropSchema?: () => Promise<void> } };
        await d.db?.dropSchema?.();
      }

      await state.close();
      await db.close();

      if (!keepDir) {
        rmSync(dir, { recursive: true, force: true });
        setDataDir(null); setSchema(null);   // 정리를 끝낸 뒤에 격리를 푼다
      }
    },
  };
}

export interface Client {
  accountId: string; nickname: string; cookie: string; socket: Socket;
  send(msg: ClientMessage): void;
  next<T extends ServerMessage['t']>(t: T, timeoutMs?: number): Promise<Extract<ServerMessage, { t: T }>>;
  /** 조건을 만족하는 메시지가 올 때까지 기다린다 — 상태 메시지는 최신값이 중요하다 */
  until<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean, timeoutMs?: number): Promise<Extract<ServerMessage, { t: T }>>;
  drain<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[];
  clear(): void;
  close(): void;
}

export async function signUp(h: Harness, nickname: string): Promise<Client> {
  const email = `${nickname.toLowerCase()}@example.com`;
  const res = await fetch(`${h.url}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, nickname, password: 'password123' }),
  });
  if (!res.ok) throw new Error(`signup 실패: ${res.status} ${await res.text()}`);
  const acc = (await res.json()) as { accountId: string; nickname: string };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;

  const socket = io(h.url, { transports: ['websocket'], extraHeaders: { cookie }, forceNew: true });
  const inbox: ServerMessage[] = [];
  socket.on('msg', (m: ServerMessage) => inbox.push(m));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('소켓 연결 시간 초과')), 5000);
  });

  return {
    accountId: acc.accountId, nickname: acc.nickname, cookie, socket,
    send(msg) { socket.emit('msg', msg); },
    async next(t, timeoutMs = 5000) {
      const found = inbox.find((m) => m.t === t);
      if (found) { inbox.splice(inbox.indexOf(found), 1); return found as never; }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off('msg', on); reject(new Error(`${t} 대기 시간 초과`)); }, timeoutMs);
        const on = (m: ServerMessage): void => {
          if (m.t !== t) return;
          clearTimeout(timer); socket.off('msg', on);
          const i = inbox.indexOf(m); if (i >= 0) inbox.splice(i, 1);
          resolve(m as never);
        };
        socket.on('msg', on);
      });
    },
    async until(t, pred, timeoutMs = 5000) {
      for (let i = inbox.length - 1; i >= 0; i--) {
        const m = inbox[i]!;
        if (m.t === t && pred(m as never)) { inbox.splice(i, 1); return m as never; }
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off('msg', on); reject(new Error(`${t} 조건 대기 시간 초과`)); }, timeoutMs);
        const on = (m: ServerMessage): void => {
          if (m.t !== t || !pred(m as never)) return;
          clearTimeout(timer); socket.off('msg', on);
          const i = inbox.indexOf(m); if (i >= 0) inbox.splice(i, 1);
          resolve(m as never);
        };
        socket.on('msg', on);
      });
    },
    clear() { inbox.length = 0; },
    drain(t) {
      const out = inbox.filter((m) => m.t === t);
      for (const m of out) inbox.splice(inbox.indexOf(m), 1);
      return out as never;
    },
    close() { socket.close(); },
  };
}

export const api = async (h: Harness, c: Client, path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(`${h.url}${path}`, {
    method, headers: { 'content-type': 'application/json', cookie: c.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
};
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
