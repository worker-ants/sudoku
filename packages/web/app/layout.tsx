import type { ReactNode } from 'react';
import './globals.css';
import { THEME_BOOTSTRAP } from '../lib/theme';

export const metadata = { title: '스도쿠 — 멀티플레이', description: '여럿이 함께 푸는 스도쿠' };

export default function RootLayout({ children }: { children: ReactNode }) {
  // suppressHydrationWarning 은 아래 인라인 스크립트 때문에 필요하다 — 스크립트가
  // React 보다 먼저 <html> 에 data-theme 을 붙이므로 서버가 보낸 HTML 과 어긋난다.
  // <html> 의 속성 하나를 위한 것이고 자식 요소에는 영향이 없다.
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/*
          저장된 테마를 **첫 페인트 전에** 루트에 심는다 (ADR-STACK §4.5 · S5).
          CSR 전용이라 첫 HTML 은 빈 껍데기지만 배경색은 그 껍데기부터 칠해지므로,
          React 를 기다리면 흰 화면이 한 번 번쩍인 뒤 다크로 바뀐다.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
