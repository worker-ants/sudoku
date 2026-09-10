/**
 * 진행 중 상태 어댑터 — 개발·시험용.
 *
 * 운영은 Redis 다(ADR-STACK S2). 이 어댑터는 그 자리를 파일로 채워 **재시작 복구가
 * 실제로 되는 것을 시연**한다 — 상태가 앱 프로세스 밖에 있다는 성질이 핵심이고,
 * 그 성질은 파일에서도 같다. `REDIS_URL` 이 있으면 Redis 어댑터가 대신 쓰인다.
 *
 * 매 변경마다 쓴다(§6.3). temp → rename 이라 중간에 죽어도 파일이 반쪽이 되지 않는다.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StateStore } from './ports.js';

/** 한 칸 — `e` 는 만료 시각(epoch ms). 없으면 수명이 없다는 뜻이다 */
interface Entry { v: unknown; e?: number }

/**
 * 파일 형태는 두 가지다.
 *   v1(옛 것)  `{ "key": value, … }`            — 수명 개념이 없다
 *   v2(지금)   `{ "version": 2, "entries": { "key": { "v": …, "e": … } } }`
 *
 * `version` 이 없으면 v1 으로 읽는다. 봉투를 씌운 이유는 **값과 메타데이터를 구분할
 * 자리가 필요해서**다 — 키마다 `{v,e}` 를 쓰면서 봉투가 없으면, 저장된 값 자체가 우연히
 * `{v,e}` 모양일 때 만료 정보와 구분되지 않는다.
 */
export class FileStateStore implements StateStore {
  private readonly data = new Map<string, Entry>();
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (parsed['version'] === 2) {
          for (const [k, e] of Object.entries(parsed['entries'] as Record<string, Entry>)) this.data.set(k, e);
        } else {
          for (const [k, v] of Object.entries(parsed)) this.data.set(k, { v });   // v1 — 수명 없음
        }
      } catch { /* 깨진 파일은 빈 상태로 시작한다 */ }
    }
    this.sweep(Date.now());
  }
  /** 만료된 칸을 걷어낸다. 지운 것이 있으면 true */
  private sweep(now: number): boolean {
    let removed = false;
    for (const [k, e] of this.data) if (e.e !== undefined && e.e <= now) { this.data.delete(k); removed = true; }
    return removed;
  }
  private flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 2, entries: Object.fromEntries(this.data) }), 'utf8');
    renameSync(tmp, this.file);
  }
  async get<T>(key: string): Promise<T | null> {
    const e = this.data.get(key);
    if (!e) return null;
    // 만료된 칸은 없는 것으로 답하고 그 자리에서 지운다 — Redis 가 하는 일과 같다
    if (e.e !== undefined && e.e <= Date.now()) { this.data.delete(key); this.flush(); return null; }
    return e.v as T;
  }
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const e: Entry = ttlMs !== undefined && ttlMs > 0 ? { v: value, e: Date.now() + ttlMs } : { v: value };
    this.data.set(key, e);
    this.flush();
  }
  async del(key: string): Promise<void> { this.data.delete(key); this.flush(); }

  /**
   * 잠금 세 가지 — 파일 어댑터는 **한 프로세스 안**이라 Map 검사만으로 원자적이다.
   * (자바스크립트는 await 사이에서만 양보한다. 아래 셋은 await 를 건너지 않는다.)
   *
   * 잠금을 파일에 쓰지 않는다. 잠금은 살아 있는 프로세스의 것이고, 재시작하면
   * 풀리는 편이 옳다 — 파일에 남기면 죽은 프로세스의 잠금이 부활한다.
   */
  private readonly locks = new Map<string, { token: string; until: number }>();
  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const cur = this.locks.get(key);
    if (cur && cur.until > now && cur.token !== token) return false;
    this.locks.set(key, { token, until: now + ttlMs });
    return true;
  }
  async release(key: string, token: string): Promise<void> {
    if (this.locks.get(key)?.token === token) this.locks.delete(key);
  }
  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    const cur = this.locks.get(key);
    if (!cur || cur.token !== token || cur.until <= Date.now()) return false;
    cur.until = Date.now() + ttlMs;
    return true;
  }
  async keys(prefix: string): Promise<string[]> {
    if (this.sweep(Date.now())) this.flush();
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
  async close(): Promise<void> { this.sweep(Date.now()); this.flush(); }
}

export const stateFilePath = (dir = process.env.DATA_DIR ?? '.data'): string => join(dir, 'state.json');
