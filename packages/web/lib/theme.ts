/**
 * 테마 설정 (ADR-STACK §4.5 · S5)
 *
 * 값은 셋이고 기본은 `system` 이다. **브라우저에만 둔다** — 서버로 가지 않는다.
 * 계정에 두지 않는 이유는 두 가지다. 로그인 화면도 테마가 맞아야 하는데 계정 값은
 * 세션이 풀릴 때까지 읽을 수 없고, 테마는 기기별 취향이라 동기화가 오히려 방해다.
 *
 * 첫 페인트 전 적용은 이 모듈이 하지 않는다 — `layout.tsx` 의 인라인 스크립트가
 * React 보다 먼저 루트에 `data-theme` 을 심는다. 여기서는 그 뒤의 변경만 다룬다.
 */
export type Theme = 'system' | 'light' | 'dark';

export const THEMES: Theme[] = ['system', 'light', 'dark'];
export const THEME_LABEL: Record<Theme, string> = {
  system: '시스템',
  light: '라이트',
  dark: '다크',
};

export const THEME_KEY = 'sudoku.theme';

const isTheme = (v: unknown): v is Theme => v === 'system' || v === 'light' || v === 'dark';

/** 저장된 값. 없거나 망가졌으면 `system` 이다. */
export function readTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : 'system';
  } catch {
    return 'system';           // 사생활 보호 모드 등에서 접근 자체가 던진다
  }
}

/**
 * 루트에 반영한다. `system` 은 **속성을 지운다** — 속성이 없는 것이 곧 시스템 추종이고,
 * 그 상태에서 `prefers-color-scheme` 미디어 쿼리가 일한다(globals.css).
 */
export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

export function saveTheme(t: Theme): void {
  try {
    if (t === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, t);
  } catch { /* 저장이 안 되어도 이번 세션에는 적용된다 */ }
  applyTheme(t);
}

/**
 * 첫 페인트 전에 실행되는 스크립트의 본문.
 *
 * `layout.tsx` 가 이것을 그대로 `<head>` 에 심는다. 저장된 값을 읽어 속성을 붙이는 것이
 * 전부이고, **실패해도 조용히 넘어간다** — 여기서 던지면 페이지가 통째로 죽는다.
 */
export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
