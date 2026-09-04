/**
 * 계정·인증 (AREA-AUTH)
 * 이메일은 연락처가 아니라 로그인 ID 다(K6) — 어떤 메일도 보내지 않는다.
 * 세션은 서버가 갖는다(K1) — 즉시 무효화가 가능해야 룸 소켓 규칙을 집행할 수 있다.
 */
import { Injectable, Inject } from '@nestjs/common';
import { randomUUID, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { seasonIndex } from '@sudoku/core';
import { CONFIG } from '../config.js';
import type { ResultStore, StateStore } from '../storage/ports.js';

export interface Session { sessionId: string; accountId: string; createdAtMs: number; lastSeenMs: number }
export interface PublicAccount { accountId: string; nickname: string; email: string }

const NICK_RE = /^[가-힣a-zA-Z0-9_]+(?: [가-힣a-zA-Z0-9_]+)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

@Injectable()
export class AuthService {
  constructor(
    @Inject('ResultStore') private readonly db: ResultStore,
    @Inject('StateStore') private readonly state: StateStore,
  ) {}

  /** 로그인 시도 제한 — 계정당 지수 백오프. 완전 잠금은 그 자체가 공격 수단이 된다 */
  private readonly failures = new Map<string, { count: number; nextAllowedMs: number }>();

  validateNickname(nickname: string): string | null {
    const n = nickname.trim();
    if (n.length < 2 || n.length > 16) return '닉네임은 2~16자입니다';
    if (!NICK_RE.test(n)) return '닉네임은 한글·영문·숫자·밑줄만 쓸 수 있고 앞뒤·연속 공백은 안 됩니다';
    return null;
  }

  async signUp(input: { email: string; nickname: string; password: string }): Promise<PublicAccount> {
    const email = input.email.trim().toLowerCase();
    const nickname = input.nickname.trim();
    if (!EMAIL_RE.test(email)) throw new AuthError('bad-email', '이메일 형식이 올바르지 않습니다');
    const nickErr = this.validateNickname(nickname);
    if (nickErr) throw new AuthError('bad-nickname', nickErr);
    if (input.password.length < 8) throw new AuthError('bad-password', '비밀번호는 8자 이상입니다');
    if (await this.db.findAccountByEmail(email)) throw new AuthError('email-taken', '이미 쓰이고 있는 이메일입니다');
    if (await this.db.findAccountByNickname(nickname)) throw new AuthError('nickname-taken', '이미 쓰이고 있는 닉네임입니다');

    const accountId = `ac_${randomUUID().slice(0, 8)}`;
    await this.db.createAccount({
      accountId, email, nickname,
      passwordHash: await argon2.hash(input.password, { type: argon2.argon2id }),
      createdAtEpochMs: Date.now(), nicknameChangedSeason: null,
    });
    return { accountId, nickname, email };
  }

  async logIn(email: string, password: string): Promise<PublicAccount> {
    const key = email.trim().toLowerCase();
    const f = this.failures.get(key);
    if (f && Date.now() < f.nextAllowedMs) {
      throw new AuthError('too-many', `잠시 뒤 다시 시도하세요 (${Math.ceil((f.nextAllowedMs - Date.now()) / 1000)}초)`);
    }
    const acc = await this.db.findAccountByEmail(key);
    const ok = acc ? await argon2.verify(acc.passwordHash, password).catch(() => false) : false;
    if (!acc || !ok) {
      const prev = this.failures.get(key)?.count ?? 0;
      const count = prev + 1;
      const backoff = count >= 5 ? 2 ** (count - 5) * 1000 : 0;
      this.failures.set(key, { count, nextAllowedMs: Date.now() + backoff });
      throw new AuthError('bad-credentials', '이메일 또는 비밀번호가 올바르지 않습니다');
    }
    this.failures.delete(key);
    return { accountId: acc.accountId, nickname: acc.nickname, email: acc.email };
  }

  async createSession(accountId: string): Promise<string> {
    const sessionId = randomBytes(24).toString('base64url');
    const now = Date.now();
    // 저장소에도 같은 수명을 건다 — 읽을 때만 판정하면 다시 읽히지 않는 세션이 영영 남는다
    await this.state.set<Session>(`session:${sessionId}`, { sessionId, accountId, createdAtMs: now, lastSeenMs: now }, CONFIG.sessionTtlMs);
    return sessionId;
  }
  /** 30일 슬라이딩 — 활동할 때마다 연장한다 */
  async resolveSession(sessionId: string | undefined): Promise<PublicAccount | null> {
    if (!sessionId) return null;
    const s = await this.state.get<Session>(`session:${sessionId}`);
    if (!s) return null;
    if (Date.now() - s.lastSeenMs > CONFIG.sessionTtlMs) { await this.state.del(`session:${sessionId}`); return null; }
    s.lastSeenMs = Date.now();
    await this.state.set(`session:${sessionId}`, s, CONFIG.sessionTtlMs);   // 다시 쓰면 수명도 밀린다 = 슬라이딩
    const acc = await this.db.findAccountById(s.accountId);
    return acc ? { accountId: acc.accountId, nickname: acc.nickname, email: acc.email } : null;
  }
  async destroySession(sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.state.del(`session:${sessionId}`);
  }

  /** 닉네임 변경은 시즌당 1회. 시즌 경계는 UTC 다(R10) */
  async changeNickname(accountId: string, nickname: string): Promise<void> {
    const err = this.validateNickname(nickname);
    if (err) throw new AuthError('bad-nickname', err);
    const acc = await this.db.findAccountById(accountId);
    if (!acc) throw new AuthError('no-account', '계정을 찾을 수 없습니다');
    const season = seasonIndex(Date.now(), { epochMs: CONFIG.seasonEpochMs });
    if (acc.nicknameChangedSeason === season) throw new AuthError('nickname-cooldown', '닉네임은 시즌당 한 번만 바꿀 수 있습니다');
    if (await this.db.findAccountByNickname(nickname)) throw new AuthError('nickname-taken', '이미 쓰이고 있는 닉네임입니다');
    await this.db.updateNickname(accountId, nickname, season);
  }
}
