/**
 * 런타임에 갈아 끼우는 설정.
 * 통합 시험이 프로세스를 공유할 수 있으므로 **환경변수에 기대지 않는다** —
 * 같은 워커에서 두 하네스가 돌면 env 는 서로를 덮는다.
 */
import { CONFIG } from './config.js';

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
