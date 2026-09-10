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
import { createBus, createStateStore } from './storage/state.factory.js';
import type { ResultStore, StateStore } from './storage/ports.js';
import type { Bus } from './cluster/bus.js';
import { randomUUID } from 'node:crypto';
import { DistributedMutex } from './room/distributed-mutex.js';
import { CONFIG } from './config.js';
import { getDataDir, getSchema, getSharedResultStore } from './runtime-config.js';
import { join } from 'node:path';

@Module({
  controllers: [HttpController],
  providers: [
    {
      provide: 'StateStore',
      useFactory: (): Promise<StateStore> => createStateStore(getDataDir()),
    },
    {
      provide: 'Bus',
      useFactory: (): Promise<Bus> => createBus(),
    },
    {
      /**
       * 이 노드의 이름. 판 소유권과 소켓 퇴거에서 "나" 를 가리킨다.
       *
       * 파드 이름 같은 것을 쓰지 않는다 — 같은 파드가 재시작하면 이름이 같아지고,
       * 그러면 죽기 전에 남긴 소유권을 새 프로세스가 제 것으로 착각한다. 프로세스마다
       * 새로 만드는 편이 그 창을 아예 없앤다.
       */
      provide: 'NodeId',
      useFactory: (): string => randomUUID(),
    },
    {
      provide: 'ResultStore',
      /**
       * 스키마 생성은 **클러스터에서 한 번에 하나만** 돌아야 한다.
       * `CREATE TABLE IF NOT EXISTS` 가 동시에 돌면 Postgres 가 pg_type 유일 제약에서
       * 터진다(sql.store.ts 의 init 주석). 파드가 여럿이면 부팅이 겹치므로 실제로 만난다.
       *
       * 잠금은 상태 저장소에 있으므로 그것을 먼저 받는다 — 그래서 이 공급자가
       * 'StateStore' 에 의존한다.
       */
      inject: ['StateStore'],
      useFactory: async (state: StateStore): Promise<ResultStore> => {
        const shared = getSharedResultStore();
        if (shared) return shared;
        const store = new SqlResultStore(driverFor(CONFIG.databaseUrl, join(getDataDir(), 'pg'), getSchema()));
        await new DistributedMutex(state).run('schema-init', () => store.init());
        return store;
      },
    },
    AuthService, RoomService, MatchService, PuzzlePoolService, RankingService, RealtimeGateway,
  ],
})
export class AppModule {}
