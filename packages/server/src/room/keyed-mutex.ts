/**
 * 키 하나당 한 줄로 세우는 잠금.
 *
 * 룸 상태는 **읽고-고쳐-쓰기**로 바뀐다. 상태 저장소가 프로세스 밖에 있으면
 * (운영의 Redis) 두 요청이 같은 룸을 동시에 읽어 서로의 수정을 덮는다 —
 * 두 사람이 같은 순간에 준비를 누르면 한 쪽이 사라지는 식이다.
 *
 * 파일 어댑터에서는 이 결함이 보이지 않았다. `get` 이 Map 에 든 **같은 객체**를
 * 돌려주기 때문에 두 수정이 한 객체에 겹쳐 쌓였다. 저장소를 바꾸면 드러나는
 * 종류의 버그라, 잠금은 저장소가 아니라 룸 쪽에 둔다.
 *
 * v1 은 서버 프로세스가 하나다(ADR-STACK). 여러 프로세스로 늘리는 순간
 * 이 잠금으로는 부족하고 Redis 쪽 잠금이 필요해진다 — 그때 갈아끼울 자리가 여기다.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.tails.set(key, mine);

    // 앞사람이 실패해도 줄은 흐른다.
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // 뒤에 아무도 붙지 않았으면 키를 버린다 — 룸이 사라져도 맵이 자라지 않는다.
      if (this.tails.get(key) === mine) this.tails.delete(key);
    }
  }

  /** 대기 중인 키 수 — 시험용 */
  get size(): number { return this.tails.size; }
}
