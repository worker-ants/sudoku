import { defineConfig } from 'vitest/config';
// 통합 시험은 포트·저장소·프로세스 상태를 잡으므로 파일 단위로 순차 실행한다
export default defineConfig({
  test: { globals: true, include: ['test/**/*.test.ts'], testTimeout: 120000, fileParallelism: false },
});
