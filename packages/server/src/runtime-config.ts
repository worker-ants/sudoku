/**
 * 런타임에 갈아 끼우는 설정.
 * 통합 시험이 프로세스를 공유할 수 있으므로 **환경변수에 기대지 않는다** —
 * 같은 워커에서 두 하네스가 돌면 env 는 서로를 덮는다.
 */
import { CONFIG } from './config.js';

let dataDirOverride: string | null = null;
export const setDataDir = (dir: string | null): void => { dataDirOverride = dir; };
export const getDataDir = (): string => dataDirOverride ?? process.env['DATA_DIR'] ?? CONFIG.dataDir;
