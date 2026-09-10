import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 시험은 워크스페이스 패키지의 **소스**를 본다.
 *
 * 패키지의 `exports` 가 `dist` 를 가리키므로, 별칭이 없으면 시험을 돌리기 전에
 * 먼저 빌드해야 한다 — 신선한 클론에서 `pnpm test` 가 "Failed to resolve entry" 로
 * 죽는다. 여기서 소스로 돌려 두면 빌드는 배포의 일이고 개발 순환은 종전대로다.
 */
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// 통합 시험은 포트·저장소·프로세스 상태를 잡으므로 파일 단위로 순차 실행한다
export default defineConfig({
  resolve: {
    alias: {
      '@sudoku/core': src('../core/src/index.ts'),
      '@sudoku/contracts': src('../contracts/src/index.ts'),
    },
  },
  test: { globals: true, include: ['test/**/*.test.ts'], testTimeout: 120000, fileParallelism: false },
});
