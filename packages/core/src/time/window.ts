/**
 * 기간의 기준은 UTC다 (DSN-RANKING §4.3 · R10).
 * 달력 창은 UTC 자정에 리셋되고, 롤링 창은 지금으로부터 거꾸로 센다.
 * **판정은 UTC, 표시는 현지다** — 이 모듈은 판정만 다룬다.
 */
export const DAY_MS = 86_400_000;
export const SEASON_WEEKS = 4;
export const SEASON_MS = SEASON_WEEKS * 7 * DAY_MS;

/** 달력 창 — UTC 자정 기준의 하루 키 */
export const utcDayKey = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);
export const utcDayStart = (epochMs: number): number => Math.floor(epochMs / DAY_MS) * DAY_MS;

/** 시즌 — 고정 시각에서 4주씩. epoch 는 서비스가 정하는 시즌 0의 시작 */
export interface SeasonConfig { epochMs: number }
export const seasonIndex = (now: number, cfg: SeasonConfig): number =>
  Math.floor((now - cfg.epochMs) / SEASON_MS);
export const seasonStart = (now: number, cfg: SeasonConfig): number =>
  cfg.epochMs + seasonIndex(now, cfg) * SEASON_MS;
export const seasonEnd = (now: number, cfg: SeasonConfig): number => seasonStart(now, cfg) + SEASON_MS;

/** 롤링 창 — 경계 직후의 구멍을 만들지 않는다 */
export const withinRolling = (atMs: number, now: number, windowMs: number): boolean =>
  atMs > now - windowMs && atMs <= now;
export const ROLLING_24H = DAY_MS;
export const ROLLING_30D = 30 * DAY_MS;
