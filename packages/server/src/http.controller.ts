import { Body, Controller, Get, HttpException, HttpStatus, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { seasonIndex, ALL_BRACKETS } from '@sudoku/core';
import { CONFIG } from './config.js';
import { AuthError, AuthService } from './auth/auth.service.js';
import { RoomError, RoomService } from './room/room.service.js';
import { RankingService } from './ranking/ranking.service.js';
import { RealtimeGateway } from './realtime/gateway.js';

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
      res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: CONFIG.sessionTtlMs });
      return acc;
    } catch (e) { return fail(e); }
  }

  @Post('auth/login')
  async login(@Body() b: { email: string; password: string }, @Res({ passthrough: true }) res: Response) {
    try {
      const acc = await this.auth.logIn(b.email, b.password);
      const sid = await this.auth.createSession(acc.accountId);
      res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: CONFIG.sessionTtlMs });
      return acc;
    } catch (e) { return fail(e); }
  }

  @Post('auth/logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.destroySession(sidOf(req));
    res.clearCookie('sid', { path: '/' });
    return { ok: true };
  }

  @Get('auth/me')
  async whoami(@Req() req: Request) { return this.me(req); }

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
