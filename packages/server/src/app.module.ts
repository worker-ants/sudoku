import { Module } from '@nestjs/common';
import { AuthService } from './auth/auth.service.js';
import { RoomService } from './room/room.service.js';
import { MatchService } from './match/match.service.js';
import { PuzzlePoolService } from './match/puzzle-pool.service.js';
import { RankingService } from './ranking/ranking.service.js';
import { RealtimeGateway } from './realtime/gateway.js';
import { HttpController } from './http.controller.js';
import { FileStateStore, stateFilePath } from './storage/file-state.store.js';
import { PgliteResultStore } from './storage/pglite.store.js';
import { RedisStateStore } from './storage/redis-state.store.js';
import type { ResultStore, StateStore } from './storage/ports.js';
import { CONFIG } from './config.js';
import { getDataDir } from './runtime-config.js';
import { join } from 'node:path';

@Module({
  controllers: [HttpController],
  providers: [
    {
      provide: 'StateStore',
      useFactory: async (): Promise<StateStore> => {
        if (CONFIG.redisUrl) {
          const { default: Redis } = await import('ioredis');
          return new RedisStateStore(new Redis(CONFIG.redisUrl) as never);
        }
        return new FileStateStore(stateFilePath(getDataDir()));
      },
    },
    {
      provide: 'ResultStore',
      useFactory: async (): Promise<ResultStore> => {
        const store = new PgliteResultStore(join(getDataDir(), 'pg'));
        await store.init();
        return store;
      },
    },
    AuthService, RoomService, MatchService, PuzzlePoolService, RankingService, RealtimeGateway,
  ],
})
export class AppModule {}
