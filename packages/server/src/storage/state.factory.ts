/**
 * 진행 중 상태 저장소와 노드 간 버스를 고르는 한 자리 (ADR-STACK §6.1).
 *
 * 앱과 시험이 **같은 함수로** 고르게 둔다. 시험이 어댑터를 직접 지어 쓰면
 * 설정이 갈라져, 운영 어댑터로 돌렸을 때만 깨지는 자리가 생긴다 — 실제로 그랬다.
 *
 * 둘을 한 파일에 두는 이유는 **짝이기 때문**이다. Redis 가 있으면 상태도 버스도
 * 거기 있고, 없으면 상태는 파일에 버스는 프로세스 안에 있다. 한쪽만 Redis 인 조합은
 * 뜻이 없다 — 노드가 여럿인데 버스가 프로세스 안이면 서로를 보지 못한다.
 */
import { FileStateStore, stateFilePath } from './file-state.store.js';
import { RedisStateStore } from './redis-state.store.js';
import type { StateStore } from './ports.js';
import { LocalBus, RedisBus, type Bus } from '../cluster/bus.js';
import { CONFIG } from '../config.js';
import { getSchema, getSharedBus, getSharedStateStore } from '../runtime-config.js';

export async function createStateStore(dataDir: string): Promise<StateStore> {
  const shared = getSharedStateStore();
  if (shared) return shared;
  if (CONFIG.redisUrl) {
    const { default: Redis } = await import('ioredis');
    return new RedisStateStore(new Redis(CONFIG.redisUrl) as never, getSchema());
  }
  return new FileStateStore(stateFilePath(dataDir));
}

export async function createBus(): Promise<Bus> {
  const shared = getSharedBus();
  if (shared) return shared;
  if (CONFIG.redisUrl) {
    const { default: Redis } = await import('ioredis');
    // ioredis 는 구독 중인 연결로 다른 명령을 보내지 못한다 — 연결이 둘이어야 한다
    const pub = new Redis(CONFIG.redisUrl);
    const sub = pub.duplicate();
    return new RedisBus(pub as never, sub as never, getSchema());
  }
  // 이름공간이 클러스터의 경계다. 이름이 없으면 이 프로세스 하나가 곧 클러스터다.
  return new LocalBus(getSchema() ?? 'default');
}
