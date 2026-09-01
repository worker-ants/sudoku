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

// 부팅 복구 — 타이머는 상태가 아니므로 종료 시각에서 다시 건다 (AREA-PLAY §4.1)
const recovered = await matches.recoverOnBoot();
if (recovered.resumed.length || recovered.finalized.length) {
  log.log(`판 복구 — 이어감 ${recovered.resumed.length}건 · 만료를 지나쳐 채점 ${recovered.finalized.length}건`);
}

pool.start();
gateway.startLobbyLoop();

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
      const m = matches.matchOfRoom(roomId);
      if (m) await matches.finish(m, 'membership-empty', Date.now());
    }
  })();
}, 5000).unref?.();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { matches.shutdown(); pool.stop(); gateway.stopLobbyLoop(); void app.close().then(() => process.exit(0)); });
}
