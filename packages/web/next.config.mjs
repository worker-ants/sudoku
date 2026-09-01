/**
 * CSR 전용 (ADR-STACK S3) — 게임 화면은 서버 렌더링을 쓰지 않는다.
 * API 와 소켓은 same-origin 으로 프록시한다. httpOnly 쿠키가 소켓 핸드셰이크에
 * 자동으로 실리려면 출처가 같아야 하기 때문이다(AREA-AUTH §2.1 ②).
 */
const SERVER = process.env.SERVER_ORIGIN ?? 'http://localhost:4000';
export default {
  reactStrictMode: false,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${SERVER}/api/:path*` },
      { source: '/socket.io/:path*', destination: `${SERVER}/socket.io/:path*` },
    ];
  },
};
