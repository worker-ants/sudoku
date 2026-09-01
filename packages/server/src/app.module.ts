import { Module } from '@nestjs/common';
import { AuthService } from './auth/auth.service.js';
import { RoomService } from './room/room.service.js';
import { MatchService } from './match/match.service.js';
import { PuzzlePoolService } from './match/puzzle-pool.service.js';
import { RankingService } from './ranking/ranking.service.js';
import { RealtimeGateway } from './realtime/gateway.js';
import { HttpController } from './http.controller.js';
import { SqlResultStore } from './storage/sql.store.js';
import { driverFor } from './storage/sql.driver.js';
import { createStateStore } from './storage/state.factory.js';
import type { ResultStore, StateStore } from './storage/ports.js';
import { CONFIG } from './config.js';
import { getDataDir, getSchema } from './runtime-config.js';
import { join } from 'node:path';

@Module({
  controllers: [HttpController],
  providers: [
    {
      provide: 'StateStore',
      useFactory: (): Promise<StateStore> => createStateStore(getDataDir()),
    },
    {
      provide: 'ResultStore',
      useFactory: async (): Promise<ResultStore> => {
        const store = new SqlResultStore(driverFor(CONFIG.databaseUrl, join(getDataDir(), 'pg'), getSchema()));
        await store.init();
        return store;
      },
    },
    AuthService, RoomService, MatchService, PuzzlePoolService, RankingService, RealtimeGateway,
  ],
})
export class AppModule {}
