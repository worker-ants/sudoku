/** 운영 어댑터 — REDIS_URL 이 있을 때만 쓰인다(ADR-STACK §6.2) */
import type { StateStore } from './ports.js';

interface MinimalRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  /** PX — 밀리초 단위 만료. ioredis 의 가변 인자 형태를 좁게 받아 쓴다 */
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  /** NX 를 더한 형태 — 없을 때만 쓴다. 이미 있으면 null 을 돌려준다 */
  set(key: string, value: string, mode: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  /** 잠금 해제·연장의 대조-후-실행을 한 왕복으로 묶는다 */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

/**
 * 값이 내 토큰일 때만 지운다. GET 뒤에 DEL 을 따로 하면 그 사이에 TTL 이 끝나고
 * 다른 노드가 잠금을 잡을 수 있다 — 그러면 남의 잠금을 푼다.
 */
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** 연장도 같은 이유로 원자적이어야 한다 */
const RENEW_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

export class RedisStateStore implements StateStore {
  private readonly ns: string;

  /**
   * namespace 를 주면 모든 키 앞에 붙는다. 서버 하나를 여러 하네스가 나눠 쓸 때
   * 남의 판이 부팅 복구에 섞여 들어오는 것을 막는다 — Postgres 쪽 스키마와 같은 역할이다.
   *
   * **운영에서는 이름공간이 클러스터의 경계이기도 하다.** 같은 이름공간을 보는 노드들이
   * 한 클러스터고, 잠금과 소유권이 그 안에서만 의미를 갖는다.
   */
  constructor(private readonly client: MinimalRedis, namespace?: string | null) {
    this.ns = namespace ? `${namespace}:` : '';
  }
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.ns + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (ttlMs !== undefined && ttlMs > 0) await this.client.set(this.ns + key, raw, 'PX', Math.ceil(ttlMs));
    else await this.client.set(this.ns + key, raw);
  }
  async del(key: string): Promise<void> { await this.client.del(this.ns + key); }
  /** 이름공간은 저장소 안쪽 사정이라, 돌려줄 때는 떼어 낸다. */
  async keys(prefix: string): Promise<string[]> {
    const found = await this.client.keys(`${this.ns}${prefix}*`);
    return this.ns ? found.map((k) => k.slice(this.ns.length)) : found;
  }

  // ── 잠금 ──────────────────────────────────────────────────────────────────
  // 잠금 값은 JSON 이 아니라 토큰 문자열 그대로다. Lua 가 대조하는 값이라
  // 따옴표가 끼면 안 된다.
  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    const r = await this.client.set(this.ns + key, token, 'PX', Math.ceil(ttlMs), 'NX');
    return r !== null;
  }
  async release(key: string, token: string): Promise<void> {
    await this.client.eval(RELEASE_LUA, 1, this.ns + key, token);
  }
  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    const r = await this.client.eval(RENEW_LUA, 1, this.ns + key, token, String(Math.ceil(ttlMs)));
    return r === 1;
  }

  async close(): Promise<void> { await this.client.quit(); }
}
