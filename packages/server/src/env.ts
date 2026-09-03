/**
 * 워크스페이스 루트의 `.env` 를 프로세스 환경에 싣는다.
 *
 * **다른 어떤 모듈보다 먼저 평가되어야 한다.** `CONFIG`(config.ts)는 모듈 최상위
 * 상수라 import 되는 순간 `process.env` 를 읽어 굳는다. 그래서 이 파일이 `main.ts` 의
 * **첫 import** 여야 하고, 여기서는 아무것도 export 하지 않는다 — 값을 내보내면
 * 누군가 그 값을 쓰려고 import 순서를 바꾸다 이 규약을 깬다.
 *
 * **싣기만 한다.** `.env` 에는 조각(POSTGRES_USER 등)만 있고 `${...}` 보간이 없다.
 * URL 조립은 config.ts 가 하므로 확장기(dotenv-expand)가 필요 없고, 그래서 이 파일을
 * 다른 로더(`node --env-file` 등)로 갈아 끼워도 결과가 같다.
 *
 * **이미 환경에 있는 값이 이긴다.** dotenv 의 기본 동작이고, docker·CI 가 넘긴 값을
 * 파일이 덮어쓰면 안 된다.
 *
 * 시험은 이 파일을 거치지 않는다 — 진입점이 main.ts 가 아니다. 그래서 `pnpm test` 는
 * `.env` 가 있든 없든 종전대로 인프로세스 PGlite 로 돈다.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// cwd 가 아니라 이 파일 위치를 기준으로 찾는다 — 어느 디렉터리에서 띄우든 같은 파일을 본다
const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');

if (existsSync(ENV_PATH)) {
  config({ path: ENV_PATH, quiet: true });
  console.log(`[env] ${ENV_PATH} 를 읽었다`);
}
