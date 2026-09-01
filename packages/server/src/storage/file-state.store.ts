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

export class FileStateStore implements StateStore {
  private readonly data = new Map<string, unknown>();
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) this.data.set(k, v);
      } catch { /* 깨진 파일은 빈 상태로 시작한다 */ }
    }
  }
  private flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data)), 'utf8');
    renameSync(tmp, this.file);
  }
  async get<T>(key: string): Promise<T | null> { return (this.data.get(key) as T) ?? null; }
  async set<T>(key: string, value: T): Promise<void> { this.data.set(key, value); this.flush(); }
  async del(key: string): Promise<void> { this.data.delete(key); this.flush(); }
  async keys(prefix: string): Promise<string[]> { return [...this.data.keys()].filter((k) => k.startsWith(prefix)); }
  async close(): Promise<void> { this.flush(); }
}

export const stateFilePath = (dir = process.env.DATA_DIR ?? '.data'): string => join(dir, 'state.json');
