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
import { setDataDir, setSchema, setSharedBus, setSharedResultStore, setSharedStateStore } from '../src/runtime-config.js';
import { MatchService } from '../src/match/match.service.js';
import { RealtimeGateway } from '../src/realtime/gateway.js';
import { RoomService } from '../src/room/room.service.js';
import type { ResultStore, StateStore } from '../src/storage/ports.js';
import type { Bus } from '../src/cluster/bus.js';
import { CONFIG } from '../src/config.js';

export interface Harness {
  app: INestApplication; url: string; dir: string;
  db: ResultStore; state: StateStore; bus: Bus;
  matches: MatchService; rooms: RoomService; gateway: RealtimeGateway;
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

/**
 * 한 노드를 띄운다.
 *
 * `cluster` 를 주면 그 노드는 **이미 있는 클러스터에 합류한다** — 상태 저장소와 버스를
 * 새로 만들지 않고 넘겨받은 것을 쓴다. 운영에서 Redis 하나를 여러 파드가 나눠 보는 것과
 * 같은 모양이고, 두 노드짜리 시험(e2e-cluster)이 그것에 기댄다.
 */
export async function startHarness(reuseDir?: string, cluster?: { state: StateStore; bus: Bus; db: ResultStore }): Promise<Harness> {
  const dir = reuseDir ?? mkdtempSync(join(tmpdir(), 'sudoku-e2e-'));
  setDataDir(dir);
  // DATABASE_URL 로 진짜 Postgres 에 붙는 경우, 하네스마다 제 스키마를 쓴다.
  // 디렉터리에서 이름을 뽑으므로 재개(reuseDir)하면 같은 스키마로 돌아온다 — 복구 시험이 그것에 기댄다.
  setSchema(`t_${dir.split(/[\\/]/).pop()!.replace(/[^a-zA-Z0-9]/g, '_')}`);
  setSharedStateStore(cluster?.state ?? null);
  setSharedBus(cluster?.bus ?? null);
  setSharedResultStore(cluster?.db ?? null);
  const app = await NestFactory.create(AppModule, { logger: false, cors: { origin: true, credentials: true } });
  await app.listen(0);
  const url = await app.getUrl();
  const db = app.get<ResultStore>('ResultStore');
  const state = app.get<StateStore>('StateStore');
  const bus = app.get<Bus>('Bus');
  // 중계를 듣기 시작한다. 이것이 빠지면 나가는 메시지가 버스에만 실리고 소켓에 닿지 않는다.
  await app.get(RealtimeGateway).joinCluster();
  // 공유 자원은 다음 노드가 제 것을 만들지 않도록 남겨 두고, 아니면 바로 푼다
  setSharedStateStore(null); setSharedBus(null); setSharedResultStore(null);
  return {
    app, url: url.replace('[::1]', '127.0.0.1'), dir, db, state, bus,
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
      await app.get(MatchService).shutdown();   // 소유권을 놓는다 — 다음 노드가 기다리지 않도록
      await settleRooms(app.get(RoomService));

      // 클러스터에 합류한 노드는 남의 살림을 치우지 않는다 — 아직 쓰는 노드가 있다
      if (!keepDir && !cluster) {
        // 남긴 상태를 지운다. 파일 어댑터는 아래 rmSync 로 통째 사라지지만 **Redis 에는
        // 그런 것이 없어**, 지우지 않으면 이 하네스의 이름공간이 서버에 그대로 쌓인다.
        // rmSync 의 대응물이 여기다.
        if (CONFIG.redisUrl) for (const k of await state.keys('')) await state.del(k);
        // 스키마 삭제는 풀을 닫기 전에 — 닫은 뒤에 부르면 풀을 다시 여는 꼴이 된다
        const d = db as unknown as { db?: { dropSchema?: () => Promise<void> } };
        await d.db?.dropSchema?.();
      }

      // 클러스터에서 빌려 쓴 것은 닫지 않는다 — 다른 노드가 아직 쓰고 있다
      if (!cluster) { await bus.close(); await state.close(); await db.close(); }

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

/**
 * 가입하고 소켓까지 연다.
 *
 * `socketOn` 을 주면 **소켓만 다른 노드에** 붙인다 — 두 노드짜리 시험이 "A 에 가입한
 * 사람이 B 에 접속한" 상황을 만드는 데 쓴다. 세션 쿠키는 두 노드가 같은 저장소를
 * 보므로 그대로 통한다.
 */
export async function signUp(h: Harness, nickname: string, opts: { socketOn?: Harness } = {}): Promise<Client> {
  const email = `${nickname.toLowerCase()}@example.com`;
  const res = await fetch(`${h.url}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, nickname, password: 'password123' }),
  });
  if (!res.ok) throw new Error(`signup 실패: ${res.status} ${await res.text()}`);
  const acc = (await res.json()) as { accountId: string; nickname: string };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;

  const socket = io((opts.socketOn ?? h).url, { transports: ['websocket'], extraHeaders: { cookie }, forceNew: true });
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
