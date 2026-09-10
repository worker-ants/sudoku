/**
 * 노드를 건너 거는 잠금.
 *
 * [[keyed-mutex.ts]] 가 "여러 프로세스로 늘리는 순간 갈아끼울 자리" 라고 표시해 두었던
 * 그 자리다. 프로세스 안 잠금은 같은 프로세스의 두 요청만 세운다 — 노드가 둘이면
 * 두 노드가 같은 룸을 동시에 읽어 서로의 수정을 덮는다.
 *
 * **둘을 겹쳐 쓴다.**
 *   ① 프로세스 안 KeyedMutex — 같은 노드의 대기자들을 줄 세운다. 공짜다.
 *   ② 상태 저장소의 잠금   — 노드 하나만 통과시킨다. Redis 왕복이 든다.
 *
 * ①이 앞에 있으므로 ②를 두드리는 것은 **노드마다 한 번에 하나**뿐이다. 프로세스 안
 * 대기자 열 명이 각자 Redis 를 재시도하며 도는 일이 없다.
 */
import { randomUUID } from 'node:crypto';
import type { StateStore } from '../storage/ports.js';
import { KeyedMutex } from './keyed-mutex.js';

/**
 * 잠금의 수명.
 *
 * 임계 구역보다 넉넉해야 한다 — 짧으면 일하는 중에 풀려 둘이 들어온다. 룸 변경은
 * 대개 Redis 왕복 몇 번이지만 **판 시작은 퍼즐 배정 때문에 Postgres 까지 다녀온다.**
 * 그래서 넉넉히 두고, 그래도 넘길 만큼 오래 걸리면 아래 갱신 타이머가 늘려 준다.
 */
const LOCK_TTL_MS = 15_000;
/** 수명의 1/3 마다 늘린다 — 한 번 놓쳐도 아직 여유가 있다 */
const RENEW_EVERY_MS = 5_000;
/** 이만큼 기다려도 못 잡으면 포기한다. 무한정 매달리면 요청이 쌓이기만 한다 */
const MAX_WAIT_MS = 20_000;
const RETRY_MS = 25;

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`잠금 ${key} 을 ${MAX_WAIT_MS}ms 안에 잡지 못했다`);
    this.name = 'LockTimeoutError';
  }
}

export class DistributedMutex {
  private readonly local = new KeyedMutex();

  constructor(private readonly state: StateStore) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.local.run(key, () => this.withRemote(key, fn));
  }

  private async withRemote<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();
    const until = Date.now() + MAX_WAIT_MS;

    while (!(await this.state.acquire(lockKey, token, LOCK_TTL_MS))) {
      if (Date.now() > until) throw new LockTimeoutError(key);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }

    // 오래 걸리는 임계 구역에서 잠금이 만료되지 않게 붙잡고 있는다.
    const renew = setInterval(() => { void this.state.renew(lockKey, token, LOCK_TTL_MS); }, RENEW_EVERY_MS);
    renew.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      await this.state.release(lockKey, token);
    }
  }

  /** 대기 중인 키 수 — 시험이 조용해질 때를 기다리는 데 쓴다 */
  get size(): number { return this.local.size; }
}
