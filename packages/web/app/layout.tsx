import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: '스도쿠 — 멀티플레이', description: '여럿이 함께 푸는 스도쿠' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
