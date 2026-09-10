/**
 * 런타임에 갈아 끼우는 설정.
 * 통합 시험이 프로세스를 공유할 수 있으므로 **환경변수에 기대지 않는다** —
 * 같은 워커에서 두 하네스가 돌면 env 는 서로를 덮는다.
 */
import { CONFIG } from './config.js';
import type { ResultStore, StateStore } from './storage/ports.js';
import type { Bus } from './cluster/bus.js';

let dataDirOverride: string | null = null;
export const setDataDir = (dir: string | null): void => { dataDirOverride = dir; };
export const getDataDir = (): string => dataDirOverride ?? process.env['DATA_DIR'] ?? CONFIG.dataDir;

/**
 * 진짜 PostgreSQL 에 붙을 때의 격리 단위.
 * PGlite 는 하네스마다 다른 디렉터리를 주면 저절로 갈라지지만, 서버 하나를 공유할 때는
 * 스키마가 그 자리를 대신한다 — 하네스마다 제 스키마를 쓰고 끝나면 지운다.
 */
let schemaOverride: string | null = null;
export const setSchema = (schema: string | null): void => { schemaOverride = schema; };
export const getSchema = (): string | null => schemaOverride;

/**
 * 한 프로세스 안에서 노드를 여럿 띄울 때 공유하는 것 둘.
 *
 * 운영에서는 Redis 가 이 자리를 맡는다 — 노드마다 제 클라이언트를 만들어 같은 서버를
 *본다. 시험은 그 "같은 서버" 를 객체 하나로 대신한다. 노드를 건너는 코드(중계·명령·
 * 소유권)가 실제로 도는지 보려는 것이고, 그 코드는 버스가 무엇이든 같다.
 *
 * 비워 두면 각 노드가 제 것을 만든다 — 평소의 길이다.
 */
let sharedStateStore: StateStore | null = null;
export const setSharedStateStore = (s: StateStore | null): void => { sharedStateStore = s; };
export const getSharedStateStore = (): StateStore | null => sharedStateStore;

let sharedBus: Bus | null = null;
export const setSharedBus = (b: Bus | null): void => { sharedBus = b; };
export const getSharedBus = (): Bus | null => sharedBus;

/** 영구 저장소도 같다 — 운영에서 파드들이 Postgres 하나를 나눠 본다 */
let sharedResultStore: ResultStore | null = null;
export const setSharedResultStore = (s: ResultStore | null): void => { sharedResultStore = s; };
export const getSharedResultStore = (): ResultStore | null => sharedResultStore;
