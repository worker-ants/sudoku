/**
 * 노드 사이의 발행·구독 (ADR-STACK §6.6 — 서버가 여럿일 때)
 *
 * 서버 프로세스가 하나였을 때는 필요 없던 물건이다. 여럿이 되면 두 가지가 프로세스
 * 경계에서 끊긴다.
 *
 *   ① **나가는 메시지** — 한 룸의 참가자들이 서로 다른 노드에 붙어 있다.
 *      A 노드가 자기 소켓에만 뿌리면 B 노드에 붙은 사람은 아무것도 못 본다.
 *   ② **판 명령** — 진행 중인 판의 상태와 타이머는 한 노드에 있다. 다른 노드에 붙은
 *      참가자의 입력은 그 노드로 건너가야 한다.
 *
 * 둘 다 "누가 어디에 붙어 있는지 모른 채 보낸다" 는 모양이라 발행·구독 하나로 덮는다.
 *
 * **버스는 전달만 한다.** 무엇을 보낼지, 보내도 되는지는 게이트웨이가 판단한다 —
 * 정답 유출 검사는 메시지를 **만든 노드에서** 이미 끝난다(realtime/gateway.ts).
 */
export interface Bus {
  publish(channel: string, payload: unknown): Promise<void>;
  /** 같은 채널을 두 번 구독하면 핸들러가 더해진다 */
  subscribe(channel: string, handler: (payload: unknown) => void): Promise<void>;
  /** 그 채널의 핸들러를 전부 뗀다 */
  unsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
}

// ── 프로세스 안 버스 ────────────────────────────────────────────────────────

/**
 * 같은 이름의 클러스터에 속한 LocalBus 들이 공유하는 자리.
 *
 * 개발·시험에서는 노드가 한 프로세스 안에 여럿 뜬다. 그때 이 레지스트리가 Redis 의
 * 자리를 대신한다 — **경계는 같다.** 이름이 다르면 서로를 보지 못한다.
 */
const REGISTRY = new Map<string, Set<LocalBus>>();

export class LocalBus implements Bus {
  private readonly handlers = new Map<string, ((payload: unknown) => void)[]>();
  private readonly peers: Set<LocalBus>;

  constructor(private readonly cluster = 'default') {
    let set = REGISTRY.get(cluster);
    if (!set) { set = new Set(); REGISTRY.set(cluster, set); }
    set.add(this);
    this.peers = set;
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    // JSON 을 한 번 왕복시킨다. Redis 를 지나면 그렇게 되므로, 참조를 공유하는
    // 지름길이 시험에서만 통하는 일이 없도록 여기서도 같은 값을 만든다.
    const wire = JSON.stringify(payload);
    for (const peer of [...this.peers]) {
      const hs = peer.handlers.get(channel);
      if (!hs?.length) continue;
      // 발행자에게도 돌아온다 — Redis 와 같다. 그래야 보내는 쪽 코드가 한 갈래로 끝난다.
      setImmediate(() => { for (const h of [...hs]) h(JSON.parse(wire)); });
    }
  }
  async subscribe(channel: string, handler: (payload: unknown) => void): Promise<void> {
    const hs = this.handlers.get(channel) ?? [];
    hs.push(handler);
    this.handlers.set(channel, hs);
  }
  async unsubscribe(channel: string): Promise<void> { this.handlers.delete(channel); }
  async close(): Promise<void> { this.handlers.clear(); this.peers.delete(this); }
}

// ── Redis 버스 ─────────────────────────────────────────────────────────────

interface MinimalPubSub {
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

/**
 * ioredis 는 **구독 중인 연결로 다른 명령을 보낼 수 없다.** 그래서 연결이 둘이다 —
 * 발행용 하나, 구독용 하나. 구독용은 상태 저장소가 쓰는 연결을 복제해서 만든다.
 */
export class RedisBus implements Bus {
  private readonly handlers = new Map<string, ((payload: unknown) => void)[]>();
  private readonly ns: string;

  constructor(
    private readonly pub: MinimalPubSub,
    private readonly sub: MinimalPubSub,
    namespace?: string | null,
  ) {
    this.ns = namespace ? `${namespace}:` : '';
    this.sub.on('message', (channel, message) => {
      const hs = this.handlers.get(channel.slice(this.ns.length));
      if (!hs?.length) return;
      let payload: unknown;
      try { payload = JSON.parse(message); } catch { return; }   // 남이 쓴 채널이면 조용히 버린다
      for (const h of [...hs]) h(payload);
    });
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.pub.publish(this.ns + channel, JSON.stringify(payload));
  }
  async subscribe(channel: string, handler: (payload: unknown) => void): Promise<void> {
    const hs = this.handlers.get(channel) ?? [];
    hs.push(handler);
    this.handlers.set(channel, hs);
    if (hs.length === 1) await this.sub.subscribe(this.ns + channel);
  }
  async unsubscribe(channel: string): Promise<void> {
    if (!this.handlers.delete(channel)) return;
    await this.sub.unsubscribe(this.ns + channel);
  }
  async close(): Promise<void> {
    this.handlers.clear();
    await this.sub.quit();
    await this.pub.quit();
  }
}

// ── 채널 이름 ──────────────────────────────────────────────────────────────

/** 모든 노드가 듣는다 — 소켓으로 나갈 것들 */
export const RELAY_CHANNEL = 'relay';
/** 판 하나짜리 채널 — 그 판을 가진 노드만 듣는다 */
export const commandChannel = (roomId: string): string => `cmd:${roomId}`;
