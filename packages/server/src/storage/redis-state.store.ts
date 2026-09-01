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
  constructor(private readonly client: MinimalRedis) {}
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }
  async set<T>(key: string, value: T): Promise<void> { await this.client.set(key, JSON.stringify(value)); }
  async del(key: string): Promise<void> { await this.client.del(key); }
  async keys(prefix: string): Promise<string[]> { return this.client.keys(`${prefix}*`); }
  async close(): Promise<void> { await this.client.quit(); }
}
