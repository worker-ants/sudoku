// .env 를 먼저 싣는다 — CONFIG 가 import 시점에 process.env 를 읽으므로 순서가 규약이다(env.ts)
import './env.js';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { CONFIG } from './config.js';
import { MatchService } from './match/match.service.js';
import { PuzzlePoolService } from './match/puzzle-pool.service.js';
import { RoomService } from './room/room.service.js';
import { RealtimeGateway } from './realtime/gateway.js';

const log = new Logger('main');

const app = await NestFactory.create(AppModule, { cors: { origin: true, credentials: true } });
app.enableShutdownHooks();

const matches = app.get(MatchService);
const pool = app.get(PuzzlePoolService);
const rooms = app.get(RoomService);
const gateway = app.get(RealtimeGateway);

await app.listen(CONFIG.port);
log.log(`서버 http://localhost:${CONFIG.port}`);

// 클러스터에 합류한다 — 다른 노드가 뿌리는 메시지를 이 노드의 소켓으로 전달하기 시작한다.
// listen 뒤에 부르는 이유는, 듣기 시작한 뒤 곧바로 소켓이 붙어도 상관없게 하기 위해서다.
await gateway.joinCluster();

// 부팅 복구 — 타이머는 상태가 아니므로 종료 시각에서 다시 건다 (AREA-PLAY §4.1)
const recovered = await matches.recoverOnBoot();
if (recovered.resumed.length || recovered.finalized.length) {
  log.log(`판 복구 — 이어감 ${recovered.resumed.length}건 · 만료를 지나쳐 채점 ${recovered.finalized.length}건`);
}

pool.start();
gateway.startLobbyLoop();

/**
 * 주인 없는 판을 주워 온다.
 *
 * 노드가 하나였을 때는 부팅 때 한 번이면 됐다. 여럿이면 **노드가 죽는 일**이 부팅과
 * 같은 상황을 만든다 — 그 노드가 들고 있던 판의 소유권이 수명을 다하고, 아무도 타이머를
 * 굴리지 않는 판이 남는다. 살아 있는 노드가 주기적으로 훑어 집어 온다.
 *
 * 소유권 수명(15초)보다 촘촘히 돌 이유가 없다. 늦어야 그만큼이다.
 */
setInterval(() => {
  void (async () => {
    const picked = await matches.adoptOrphans();
    if (picked.resumed.length || picked.finalized.length) {
      log.log(`주인 없던 판을 인수 — 이어감 ${picked.resumed.length}건 · 채점 ${picked.finalized.length}건`);
    }
  })();
}, 5000).unref?.();

// 룸 정리 — 유예를 넘긴 연결, 빈 룸, 유휴 30분
setInterval(() => {
  void (async () => {
    const swept = await rooms.sweepDisconnected();
    for (const r of swept.removed) {
      const room = await rooms.get(r.roomId);
      if (room) gateway['pushRoom']?.(room);
    }
    const { emptyDuringMatch } = await rooms.sweepRooms();
    for (const roomId of emptyDuringMatch) {
      // 그 판을 가진 노드가 이 노드가 아닐 수 있다 — 명령으로 보낸다
      await matches.command(roomId, { t: 'finish', reason: 'membership-empty' });
    }
  })();
}, 5000).unref?.();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void (async () => {
      // 들고 있던 판의 소유권부터 놓는다 — 다음 노드가 수명 15초를 기다리지 않도록.
      // 롤링 배포에서 이 한 줄이 진행 중인 판의 공백을 줄인다.
      pool.stop();
      gateway.stopLobbyLoop();
      await matches.shutdown();
      await app.close();
      process.exit(0);
    })();
  });
}
