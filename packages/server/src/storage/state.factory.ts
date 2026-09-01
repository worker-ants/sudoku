/**
 * 진행 중 상태 저장소를 고르는 한 자리 (ADR-STACK §6.1).
 *
 * 앱과 시험이 **같은 함수로** 고르게 둔다. 시험이 어댑터를 직접 지어 쓰면
 * 설정이 갈라져, 운영 어댑터로 돌렸을 때만 깨지는 자리가 생긴다 — 실제로 그랬다.
 */
import { FileStateStore, stateFilePath } from './file-state.store.js';
import { RedisStateStore } from './redis-state.store.js';
import type { StateStore } from './ports.js';
import { CONFIG } from '../config.js';
import { getSchema } from '../runtime-config.js';

export async function createStateStore(dataDir: string): Promise<StateStore> {
  if (CONFIG.redisUrl) {
    const { default: Redis } = await import('ioredis');
    return new RedisStateStore(new Redis(CONFIG.redisUrl) as never, getSchema());
  }
  return new FileStateStore(stateFilePath(dataDir));
}
