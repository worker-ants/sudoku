'use client';
import { io, type Socket } from 'socket.io-client';
import type { ClientMessage, ServerMessage } from '@sudoku/contracts';

export const api = async <T,>(path: string, method = 'GET', body?: unknown): Promise<{ ok: boolean; status: number; data: T }> => {
  const res = await fetch(path, {
    method, credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as T;
  return { ok: res.ok, status: res.status, data };
};

let socket: Socket | null = null;

/**
 * 소켓은 서버 오리진에 직접 붙는다.
 * Next 의 rewrite 는 HTTP 는 프록시하지만 **WebSocket 업그레이드는 넘기지 못한다.**
 * 쿠키는 포트가 달라도 같은 사이트(localhost)라 그대로 실린다 — 서버가 CORS 에서
 * credentials 를 허용하고 있으므로 핸드셰이크에 세션이 붙는다(AREA-AUTH §2.1 ②).
 */
const SOCKET_ORIGIN = process.env['NEXT_PUBLIC_SOCKET_ORIGIN'] || undefined;

export function connect(onMessage: (m: ServerMessage) => void): Socket {
  socket?.close();
  socket = SOCKET_ORIGIN
    ? io(SOCKET_ORIGIN, { transports: ['websocket', 'polling'], withCredentials: true, forceNew: true })
    : io({ transports: ['websocket', 'polling'], withCredentials: true, forceNew: true });
  socket.on('msg', onMessage);
  socket.on('connect_error', (e) => console.warn('소켓 연결 실패', e.message));
  return socket;
}
export const send = (msg: ClientMessage): void => { socket?.emit('msg', msg); };
export const disconnect = (): void => { socket?.close(); socket = null; };
