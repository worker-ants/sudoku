/** 운영 어댑터 — REDIS_URL 이 있을 때만 쓰인다(ADR-STACK §6.2) */
import type { StateStore } from './ports.js';

interface MinimalRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<unknown>;
}

export class RedisStateStore implements StateStore {
  private readonly ns: string;

  /**
   * namespace 를 주면 모든 키 앞에 붙는다. 서버 하나를 여러 하네스가 나눠 쓸 때
   * 남의 판이 부팅 복구에 섞여 들어오는 것을 막는다 — Postgres 쪽 스키마와 같은 역할이다.
   */
  constructor(private readonly client: MinimalRedis, namespace?: string | null) {
    this.ns = namespace ? `${namespace}:` : '';
  }
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.ns + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }
  async set<T>(key: string, value: T): Promise<void> { await this.client.set(this.ns + key, JSON.stringify(value)); }
  async del(key: string): Promise<void> { await this.client.del(this.ns + key); }
  /** 이름공간은 저장소 안쪽 사정이라, 돌려줄 때는 떼어 낸다. */
  async keys(prefix: string): Promise<string[]> {
    const found = await this.client.keys(`${this.ns}${prefix}*`);
    return this.ns ? found.map((k) => k.slice(this.ns.length)) : found;
  }
  async close(): Promise<void> { await this.client.quit(); }
}
