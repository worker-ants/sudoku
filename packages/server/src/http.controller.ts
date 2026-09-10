import { Body, Controller, Get, HttpException, HttpStatus, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { seasonIndex, ALL_BRACKETS } from '@sudoku/core';
import { CONFIG } from './config.js';
import { AuthError, AuthService } from './auth/auth.service.js';
import { RoomError, RoomService } from './room/room.service.js';
import { RankingService } from './ranking/ranking.service.js';
import { RealtimeGateway } from './realtime/gateway.js';

/**
 * 세션 쿠키의 속성 한 벌.
 *
 * 세 자리(가입·로그인·로그아웃)가 한 상수를 본다. 지우는 쪽이 `path` 를 빠뜨리면
 * 브라우저가 다른 쿠키로 보고 지우지 않으므로, 굽는 곳과 지우는 곳을 갈라 두지 않는다.
 *
 * `secure` 는 운영에서만 켠다. 로컬과 시험은 http 로 도는데 Secure 쿠키는 http 응답에서
 * 무시되므로, 무조건 켜면 개발이 통째로 막힌다.
 */
const SID_COOKIE = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env['NODE_ENV'] === 'production',
} as const;

const sidOf = (req: Request): string | undefined => {
  const raw = req.headers.cookie ?? '';
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(raw);
  return m ? decodeURIComponent(m[1]!) : undefined;
};
const fail = (e: unknown): never => {
  if (e instanceof AuthError || e instanceof RoomError) throw new HttpException({ code: e.code, message: e.message }, HttpStatus.BAD_REQUEST);
  throw e;
};

@Controller('api')
export class HttpController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RoomService) private readonly rooms: RoomService,
    @Inject(RankingService) private readonly ranking: RankingService,
    @Inject(RealtimeGateway) private readonly gateway: RealtimeGateway,
  ) {}

  private async me(req: Request) {
    const acc = await this.auth.resolveSession(sidOf(req));
    if (!acc) throw new HttpException({ code: 'unauthenticated', message: '로그인이 필요합니다' }, HttpStatus.UNAUTHORIZED);
    return acc;
  }

  @Get('health') health() { return { ok: true, at: Date.now() }; }

  @Post('auth/signup')
  async signup(@Body() b: { email: string; nickname: string; password: string }, @Res({ passthrough: true }) res: Response) {
    try {
      const acc = await this.auth.signUp(b);
      const sid = await this.auth.createSession(acc.accountId);
      res.cookie('sid', sid, { ...SID_COOKIE, maxAge: CONFIG.sessionTtlMs });
      return acc;
    } catch (e) { return fail(e); }
  }

  @Post('auth/login')
  async login(@Body() b: { email: string; password: string }, @Res({ passthrough: true }) res: Response) {
    try {
      const acc = await this.auth.logIn(b.email, b.password);
      const sid = await this.auth.createSession(acc.accountId);
      res.cookie('sid', sid, { ...SID_COOKIE, maxAge: CONFIG.sessionTtlMs });
      return acc;
    } catch (e) { return fail(e); }
  }

  @Post('auth/logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.destroySession(sidOf(req));
    res.clearCookie('sid', SID_COOKIE);
    return { ok: true };
  }

  @Get('auth/me')
  async whoami(@Req() req: Request) { return this.me(req); }

  /** 닉네임 변경 — 시즌당 1회 (AUTH K2) */
  @Post('auth/nickname')
  async changeNickname(@Req() req: Request, @Body() b: { nickname: string }) {
    const acc = await this.me(req);
    try {
      await this.auth.changeNickname(acc.accountId, b.nickname);
      return { accountId: acc.accountId, email: acc.email, nickname: b.nickname };
    } catch (e) { return fail(e); }
  }

  @Post('rooms')
  async createRoom(@Req() req: Request, @Body() b: { name?: string; isPublic?: boolean }) {
    const acc = await this.me(req);
    try {
      const room = await this.rooms.create(acc, b);
      this.gateway.bindRoom(acc.accountId, room.roomId);
      this.gateway.pushRoomTo(acc.accountId, room);
      void this.gateway.pushLobby(true);
      return this.rooms.toRoomView(room);
    } catch (e) { return fail(e); }
  }

  @Post('rooms/join')
  async joinRoom(@Req() req: Request, @Body() b: { code: string }) {
    const acc = await this.me(req);
    try {
      const before = await this.rooms.byCode(b.code);
      const wasEligible = before ? this.rooms.eligibility(before).eligible : false;
      const room = await this.rooms.join(acc, b.code);
      const cleared = await this.rooms.reconcileEligibility(room.roomId, wasEligible);
      this.gateway.bindRoom(acc.accountId, room.roomId);
      this.gateway.pushRoom(room);            // 이미 있던 사람들에게도 새 명단이 가야 한다
      void this.gateway.pushLobby(true);
      return { ...this.rooms.toRoomView(room), readyCleared: cleared };
    } catch (e) { return fail(e); }
  }

  @Get('rooms')
  async lobby() {
    const rooms = (await this.rooms.listRooms()).filter((r) => r.isPublic);
    return rooms.slice(0, 50).map((r) => this.rooms.toLobbyView(r));
  }

  @Get('rooms/mine')
  async mine(@Req() req: Request) {
    const acc = await this.me(req);
    const room = await this.rooms.membershipOf(acc.accountId);
    return room ? this.rooms.toRoomView(room) : null;
  }

  @Get('rankings')
  async rankings() {
    const index = seasonIndex(Date.now(), { epochMs: CONFIG.seasonEpochMs });
    const b = await this.ranking.boards(index);
    // `season` 은 시즌 순위표(배열)다. 시즌 번호는 `seasonIndex` 로 따로 나간다 —
    // 이전에는 두 값이 같은 이름을 다퉈 번호가 순위표를 덮었고, 화면이 죽었다.
    return { ...b, seasonIndex: index, brackets: ALL_BRACKETS };
  }

  @Get('records')
  async records(@Query('bracket') bracket = 'race:normal') { return this.ranking.records(bracket); }

  @Get('history')
  async history(@Req() req: Request) {
    const acc = await this.me(req);
    return this.ranking.history(acc.accountId);
  }
}
