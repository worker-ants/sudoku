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
import { setDataDir } from '../src/runtime-config.js';
import { MatchService } from '../src/match/match.service.js';
import { RealtimeGateway } from '../src/realtime/gateway.js';
import { RoomService } from '../src/room/room.service.js';
import type { ResultStore } from '../src/storage/ports.js';

export interface Harness {
  app: INestApplication; url: string; dir: string;
  db: ResultStore; matches: MatchService; rooms: RoomService; gateway: RealtimeGateway;
  seedPuzzle(difficulty: Difficulty, seed?: number): Promise<{ givens: number[]; solution: number[]; puzzleId: string }>;
  stop(keepDir?: boolean): Promise<void>;
}

export async function startHarness(reuseDir?: string): Promise<Harness> {
  const dir = reuseDir ?? mkdtempSync(join(tmpdir(), 'sudoku-e2e-'));
  setDataDir(dir);
  const app = await NestFactory.create(AppModule, { logger: false, cors: { origin: true, credentials: true } });
  await app.listen(0);
  const url = await app.getUrl();
  const db = app.get<ResultStore>('ResultStore');
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
    async stop(keepDir = false) { setDataDir(null); await app.close(); if (!keepDir) rmSync(dir, { recursive: true, force: true }); },
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
