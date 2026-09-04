# UI 시안

`ui-mockup.html` 한 장이 전부다. **의존성이 없다** — 브라우저로 바로 열면 된다.

- 스타일은 `packages/web/app/globals.css` 를 **그대로 인라인**한다. 시안 전용 값을 따로 두지 않으므로
  구현이 바뀌면 이 파일도 다시 만들어야 하고, 그래서 둘이 조용히 갈라지지 않는다.
- 색 견본은 CSS 변수에서 **읽어서** 그린다. 값을 옮겨 적지 않는다.
- 상단에서 테마 셋(시스템·라이트·다크)을 바꿔 볼 수 있다.

문서는 [SUD-DSN-UI](http://localhost:8080/p/sudoku/specs/SUD-DSN-UI) — 이 시안이 그 문서 §1~§5 의 그림이다.

## 다시 만들기

globals.css 를 고쳤으면 시안의 `<style>` 블록을 새 내용으로 갈아 끼운다.

## PDF·PNG 로 굽기

```bash
npm i puppeteer
node design/render.mjs design/ui-mockup.html ui-mockup.pdf ui-mockup.png dark
```

산출물은 커밋하지 않는다 — 언제든 다시 구울 수 있고, 저장소에 바이너리를 쌓을 이유가 없다.
