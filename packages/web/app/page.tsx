'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatMessage, Difficulty, LobbyRoomView, MatchEnded, MatchStarted, Progress, RoomView, Rules, ServerMessage, SubmitResult, SubmitWindow,
} from '@sudoku/contracts';
import { api, connect, disconnect, send } from '../lib/net';
import { DIFF_LABEL, fmtSec, isFull, peersOf, violations } from '../lib/sudoku';
import { readTheme, saveTheme, THEMES, THEME_LABEL, type Theme } from '../lib/theme';
import { Board } from './components/Board';
import { Keypad } from './components/Keypad';

type Me = { accountId: string; nickname: string; email: string };

/** 참가자 색 — 진행률 아바타와 협동의 칸 소유 표시가 같은 벌을 쓴다 */
const AVATAR_COLORS = ['#2a3bb5', '#12795c', '#b26a00', '#8a2f8f', '#0f6b8f', '#a33a3a', '#4a5568', '#1f7a5c'];

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [lobby, setLobby] = useState<LobbyRoomView[]>([]);
  const [match, setMatch] = useState<MatchStarted | null>(null);
  const [cells, setCells] = useState<number[]>(() => new Array(81).fill(0));
  const [owners, setOwners] = useState<Record<number, string>>({});
  const [progress, setProgress] = useState<Progress | null>(null);
  const [window_, setWindow_] = useState<SubmitWindow | null>(null);
  const [submitRes, setSubmitRes] = useState<SubmitResult | null>(null);
  const [hint, setHint] = useState<{ index: number; technique: string; used: number; limit: number } | null>(null);
  const [ended, setEnded] = useState<MatchEnded | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<'lobby' | 'rankings'>('lobby');
  const clockSkew = useRef(0);
  /** 채팅은 룸 안으로 한정된다(FTR-CHAT §1) — 룸이 바뀌면 이전 룸의 말이 남으면 안 된다. */
  const roomIdRef = useRef<string | null>(null);

  const say = useCallback((t: string) => { setToast(t); setTimeout(() => setToast((x) => (x === t ? null : x)), 3200); }, []);

  const onMessage = useCallback((m: ServerMessage) => {
    switch (m.t) {
      case 'room:state':
        if (roomIdRef.current !== m.room.roomId) { roomIdRef.current = m.room.roomId; setChat([]); }
        setRoom(m.room);
        if (m.room.phase !== 'playing') { setMatch(null); setWindow_(null); }
        return;
      case 'room:closed': roomIdRef.current = null; setChat([]); setRoom(null); setMatch(null); setEnded(null); say(m.reason); return;
      case 'match:started':
        clockSkew.current = m.match.serverNowEpochMs - Date.now();
        setMatch(m.match); setCells([...m.match.givens]); setOwners({});
        setEnded(null); setSubmitRes(null); setHint(null); setWindow_(null); setSelected(null);
        return;
      case 'match:snapshot':
        clockSkew.current = m.match.serverNowEpochMs - Date.now();
        setMatch(m.match); setCells(m.cells); setEnded(null);
        return;
      case 'progress': setProgress(m.progress); return;
      case 'cells':
        setCells((prev) => { const n = [...prev]; for (const c of m.relay.changes) n[c.index] = c.value; return n; });
        setOwners((prev) => { const n = { ...prev }; for (const c of m.relay.changes) n[c.index] = c.byAccountId; return n; });
        return;
      case 'submit:result':
        setSubmitRes(m.result);
        say('통과 — 완주했습니다');   // 제출은 통과만 한다 (D10 · N6)
        return;
      case 'submit:window': setWindow_(m.window.state === 'open' ? m.window : null);
        if (m.window.state === 'cancelled') say(`${m.window.cancelledByNickname}님이 제출을 취소했습니다`);
        return;
      case 'hint:result': setHint(m.hint); setSelected(m.hint.index);
        say(`${Math.floor(m.hint.index / 9) + 1}행 ${(m.hint.index % 9) + 1}열 — ${m.hint.technique}`); return;
      case 'match:ended': setEnded(m.result); setMatch(null); setWindow_(null); return;
      case 'chat': setChat((c) => [...c.slice(-99), m.message]); return;
      case 'lobby:delta': setLobby(m.upsert); return;
      case 'ready:cleared': say(`${m.reason} — ${m.changes.join(' · ')}`); return;
      case 'notice': say(m.text); return;
    }
  }, [say]);

  useEffect(() => {
    void (async () => {
      const r = await api<Me>('/api/auth/me');
      if (r.ok) setMe(r.data);
      setBooting(false);
    })();
  }, []);

  useEffect(() => {
    if (!me) return;
    connect(onMessage);
    void (async () => {
      const r = await api<RoomView | null>('/api/rooms/mine');
      if (r.ok && r.data) setRoom(r.data);
    })();
    send({ t: 'lobby:subscribe' });
    return () => disconnect();
  }, [me, onMessage]);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);

  const serverNow = now + clockSkew.current;
  const remainSec = match ? Math.max(0, Math.round((match.endsAtEpochMs - serverNow) / 1000)) : 0;
  const bad = useMemo(() => violations(cells), [cells]);
  const peers = useMemo(() => (selected === null ? new Set<number>() : peersOf(selected)), [selected]);
  const myFinished = submitRes?.passed ?? false;
  const locked = !!window_ || myFinished || !match;

  const colorOf = useCallback((accountId: string) => match?.participants.find((p) => p.accountId === accountId)?.colorIndex ?? 0, [match]);

  const setCell = (i: number, v: number) => {
    if (!match || locked || match.givens[i]) return;
    setCells((prev) => { const n = [...prev]; n[i] = v; return n; });
    if (match.mode === 'coop') setOwners((o) => ({ ...o, [i]: me!.accountId }));
    send({ t: 'cell:set', index: i, value: v });
  };
  const selectCell = (i: number) => {
    setSelected(i);
    if (match?.mode === 'coop') send({ t: 'cursor:set', index: i });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!match || selected === null || locked) return;
      if (e.key >= '1' && e.key <= '9') { setCell(selected, Number(e.key)); e.preventDefault(); }
      else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') { setCell(selected, 0); e.preventDefault(); }
      else if (e.key.startsWith('Arrow')) {
        const d = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 }[e.key]!;
        const n = selected + d;
        if (n >= 0 && n < 81) { selectCell(n); e.preventDefault(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (booting) return <div className="wrap"><p className="muted">불러오는 중…</p></div>;
  if (!me) return <Auth onDone={setMe} />;

  return (
    <>
      <header className="topbar">
        <div className="inner">
          <Wordmark />
          <div className="row" style={{ gap: 6 }}>
            {!room && <button className="ghost sm" onClick={() => setView(view === 'lobby' ? 'rankings' : 'lobby')}>{view === 'lobby' ? '랭킹' : '로비'}</button>}
            <span className="topbar-sep sep" />
            <span className="badge">{me.nickname}</span>
            <Settings />
            <button className="ghost sm" onClick={async () => { await api('/api/auth/logout', 'POST'); disconnect(); setMe(null); setRoom(null); }}>로그아웃</button>
          </div>
        </div>
      </header>

      <div className="wrap">
      {toast && <div className="toast" role="status">{toast}</div>}

      {ended && <Result ended={ended} me={me} onClose={() => setEnded(null)} isHost={room?.members.find((x) => x.accountId === me.accountId)?.isHost ?? false} />}

      {!room && view === 'lobby' && <Lobby lobby={lobby} onEnter={setRoom} say={say} />}
      {!room && view === 'rankings' && <Rankings me={me} />}

      {room && !match && !ended && <RoomPanel room={room} me={me} chat={chat} say={say} />}

      {room && match && (
        <div className="play">
          <div className="col">
            <Board
              givens={match.givens} cells={cells} selected={selected} violations={bad}
              showViolations={match.violationDisplay === 'show'}
              hintIndex={hint?.index ?? null} peers={peers}
              owners={match.mode === 'coop' ? owners : undefined}
              colorOf={match.mode === 'coop' ? colorOf : undefined}
              cursors={match.mode === 'coop' && progress?.kind === 'coop'
                ? progress.cursors.filter((c) => c.accountId !== me.accountId).map((c) => ({
                    ...c, nickname: match.participants.find((p) => p.accountId === c.accountId)?.nickname ?? '',
                  }))
                : undefined}
              readOnly={locked}
              onSelect={selectCell}
            />
            <Keypad disabled={locked || selected === null} onKey={(v) => selected !== null && setCell(selected, v)} />
            {isFull(cells) && bad.size > 0 && (
              <p className="muted" style={{ color: 'var(--danger)' }}>
                제출할 수 없습니다 — 같은 줄이나 칸에 같은 숫자가 있습니다
              </p>
            )}
          </div>

          <div className="col">
            <div className="panel"><div className="bd">
              {/* 남은 시간이 이 화면에서 가장 큰 숫자다. 1분 미만이면 색이 바뀐다. */}
              <div className={`clock${remainSec < 60 ? ' low' : ''}`}>
                <span className="t" aria-label="남은 시간">{fmtSec(remainSec)}</span>
                <span className="muted">
                  {DIFF_LABEL[match.difficulty]} · {match.mode === 'race' ? '레이스' : '협동'}
                </span>
              </div>
              <div className="meter"><i style={{ width: `${Math.max(0, Math.min(100, (remainSec / match.limitSec) * 100))}%` }} /></div>
              <div className="stats">
                <div className="stat">
                  <div className="v">{cells.filter((v, i) => !match.givens[i] && !v).length}</div>
                  <div className="k">남은 칸</div>
                </div>
                {match.hintsAllowed && (
                  <div className="stat">
                    <div className="v">{hint ? hint.limit - hint.used : 3}</div>
                    <div className="k">힌트{match.mode === 'coop' ? ' · 팀' : ''}</div>
                  </div>
                )}
                <button className="primary"
                  disabled={locked || !isFull(cells) || bad.size > 0}
                  onClick={() => send({ t: 'submit:request' })}>
                  {match.mode === 'coop' ? '팀 제출' : '제출'}
                </button>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 12 }}>
                {match.hintsAllowed && (
                  <button className="sm" disabled={locked || isFull(cells) || (hint ? hint.used >= hint.limit : false)}
                    onClick={() => send({ t: 'hint:request' })}>힌트</button>
                )}
                <button className="danger sm" onClick={() => { if (confirm('이 판의 결과는 지금 상태로 확정되어 결과와 랭킹에 반영됩니다.\n이 판에는 다시 들어올 수 없습니다.')) send({ t: 'room:leave' }); }}>나가기</button>
                <span className={match.rankEligible ? 'badge rank' : 'badge'} style={{ marginLeft: 'auto' }}>
                  {match.rankEligible && <i className="dot" />}{match.rankEligible ? '랭킹 반영' : '캐주얼'}
                </span>
              </div>
            </div></div>

            <ProgressPanel progress={progress} match={match} me={me} />
            <ChatPanel chat={chat} disabled={match.mode === 'race' && match.rankEligible} />
          </div>
        </div>
      )}

      {window_ && (
        <div className="banner" role="alertdialog" aria-label="팀 제출">
          <div className="eyebrow">팀 제출</div>
          <p style={{ margin: '8px 0 0', fontSize: 17, fontWeight: 600 }}><strong>{window_.byNickname}</strong>님이 제출을 요청했습니다</p>
          {/* 창이 닫히면 팀의 판이 끝난다 — 그 사실은 요청 문장과 카운트다운이 말한다(COOP §6.2 ①·⑤) */}
          <div className="cnt"><span>{Math.max(0, Math.ceil((window_.endsAtEpochMs - serverNow) / 1000))}</span><small>초</small></div>
          <p className="muted" style={{ margin: '2px 0 0' }}>이 동안은 누구도 칸을 고칠 수 없습니다</p>
          <button className="danger big" style={{ marginTop: 14 }}
            onClick={() => send({ t: 'submit:cancel' })}>취소</button>
        </div>
      )}
      </div>
    </>
  );
}

/** 3×3 박스에서 대각선 셋만 강조색 — 보드가 곧 로고다 */
function Wordmark() {
  return (
    <div className="brand">
      <span className="mk" aria-hidden>{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</span>
      SUDOKU
    </div>
  );
}

// ── 개인 설정 ───────────────────────────────────────────────────────────────
/**
 * v1 의 개인 설정 항목은 테마 하나뿐이라 페이지를 세우지 않고 헤더에서 연다
 * (ADR-STACK §4.5 · S5). 로그인 전에도 보이는 이유는 테마가 로그인 화면에도
 * 적용되기 때문이다 — 그래서 저장 위치가 계정이 아니라 브라우저다.
 */
function Settings() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>('system');
  // 서버 렌더 결과와 어긋나지 않도록 마운트 후에 읽는다
  useEffect(() => { setTheme(readTheme()); }, []);

  const pick = (t: Theme) => { setTheme(t); saveTheme(t); };

  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}>설정</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div className="card" role="dialog" aria-label="개인 설정"
            style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 41, minWidth: 236, padding: 14 }}>
            <h3 style={{ marginBottom: 10 }}>개인 설정</h3>
            <p className="muted" style={{ margin: '0 0 6px' }}>테마</p>
            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
              {THEMES.map((t) => (
                <button key={t} className={theme === t ? 'primary' : ''} aria-pressed={theme === t}
                  onClick={() => pick(t)} style={{ flex: 1, padding: '7px 0', fontSize: 13 }}>
                  {THEME_LABEL[t]}
                </button>
              ))}
            </div>
            <p className="muted" style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.5 }}>
              시스템은 기기 설정을 따릅니다. 이 브라우저에만 저장되며 서버로 가지 않습니다.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

// ── 인증 ────────────────────────────────────────────────────────────────────
function Auth({ onDone }: { onDone: (m: Me) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [f, setF] = useState({ email: '', nickname: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    const path = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const body = mode === 'signup' ? f : { email: f.email, password: f.password };
    const r = await api<Me & { message?: string }>(path, 'POST', body);
    if (!r.ok) { setErr(r.data?.message ?? '실패했습니다'); return; }
    onDone(r.data);
  };
  return (
    <div className="auth" style={{ position: 'relative' }}>
      <div className="auth-top"><Settings /></div>
      <div className="auth-panel">
        {/* 왼쪽은 이 제품이 무엇인지 한 번에 말한다 — 브랜드가 처음 서는 자리다 */}
        <div className="auth-hero">
          <Wordmark />
          <div className="lede">여럿이 같은 퍼즐을<br />같은 시각에</div>
          <p>
            겨루거나(레이스) 함께 풉니다(협동). 한 판의 승부는 룸 안에서 끝나고,
            쌓인 전적이 랭킹이 됩니다.
          </p>
          <div className="auth-facts">
            <div><div className="v">5</div><div className="k">난이도</div></div>
            <div><div className="v">2</div><div className="k">모드</div></div>
            <div><div className="v">3</div><div className="k">랭킹 축</div></div>
          </div>
        </div>

        <div className="auth-form">
          <div className="seg">
            <button aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>가입</button>
            <button aria-pressed={mode === 'login'} onClick={() => setMode('login')}>로그인</button>
          </div>
          {mode === 'signup' && (
            <label className="field"><span>닉네임</span>
              <input value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} placeholder="2~16자" />
            </label>
          )}
          <label className="field"><span>이메일</span>
            <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="로그인 ID 로만 쓰입니다" />
          </label>
          <label className="field"><span>비밀번호</span>
            <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="8자 이상" />
          </label>
          {err && <p style={{ color: 'var(--danger)', margin: 0, fontSize: 13 }}>{err}</p>}
          <button className="primary big" style={{ justifyContent: 'center' }} onClick={submit}>
            {mode === 'signup' ? '가입하고 시작' : '로그인'}
          </button>
          <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
            비밀번호 찾기는 아직 지원하지 않습니다. 이메일은 로그인 ID 로만 쓰이며, 어떤 메일도 보내지 않습니다.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── 로비 ────────────────────────────────────────────────────────────────────
function Lobby({ lobby, onEnter, say }: { lobby: LobbyRoomView[]; onEnter: (r: RoomView) => void; say: (s: string) => void }) {
  const [code, setCode] = useState('');
  const create = async () => {
    const r = await api<RoomView & { message?: string }>('/api/rooms', 'POST', {});
    if (r.ok) onEnter(r.data); else say(r.data?.message ?? '만들지 못했습니다');
  };
  const join = async (c: string) => {
    const r = await api<RoomView & { message?: string }>('/api/rooms/join', 'POST', { code: c });
    if (r.ok) onEnter(r.data); else say(r.data?.message ?? '들어가지 못했습니다');
  };
  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="pagehead">
        <div>
          <h1>공개 룸</h1>
          <p className="muted">지금 열려 있는 방 <span className="num">{lobby.length}</span>개</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="코드 6자리" maxLength={6} style={{ width: 132 }} />
          <button onClick={() => join(code)} disabled={code.length !== 6}>참가</button>
          <button className="primary" onClick={create}>룸 만들기</button>
        </div>
      </div>

      {lobby.length === 0 && <div className="empty">아직 열린 룸이 없습니다.<br />하나 만들어 보세요.</div>}

      {lobby.length > 0 && (
        <div className="rooms">
          {lobby.map((r) => {
            const full = r.count >= r.capacity;
            const playing = r.phase === 'playing';
            return (
              <div key={r.roomId} className={`room${playing ? ' busy' : ''}`}>
                <div className="t">
                  <div>
                    <div className="nm">{r.name}</div>
                    <div className="host">호스트 {r.hostNickname}</div>
                  </div>
                  {playing
                    ? <span className="badge warn">진행 중{r.endsInSec !== null ? ` ${fmtSec(r.endsInSec)}` : ''}</span>
                    : r.rankEligible
                      ? <span className="badge rank"><i className="dot" />랭킹</span>
                      : <span className="badge">캐주얼</span>}
                </div>
                <div className="facts">
                  <span>{r.mode === 'race' ? '레이스' : '협동'}</span>
                  <span>{DIFF_LABEL[r.difficulty]}</span>
                  <span><b className="num">{Math.round(r.limitSec / 60)}</b>분</span>
                </div>
                <div className="foot">
                  <span className="num" style={{ fontSize: 13 }}>
                    {r.count} <span style={{ color: 'var(--ink3)' }}>/ {r.capacity}</span>
                  </span>
                  <button className={playing || full ? 'sm' : 'sm primary'} disabled={playing || full}
                    onClick={() => join(r.code)}>참가</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 룸 ──────────────────────────────────────────────────────────────────────
function RoomPanel({ room, me, chat, say }: { room: RoomView; me: Me; chat: ChatMessage[]; say: (s: string) => void }) {
  const isHost = room.members.find((m) => m.accountId === me.accountId)?.isHost ?? false;
  const r = room.rules;
  const patch = (p: Partial<typeof r>, follow?: boolean) => send({ t: 'rules:update', patch: p, followStandardLimit: follow });
  return (
    <div className="roomgrid">
      <div className="col">
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{room.name}</h2>
            <span className="badge">코드 {room.code}</span>
          </div>
          <div style={{ marginTop: 10 }}>
            {room.eligibility.eligible
              ? <span className="badge rank"><i className="dot" />이 판은 랭킹에 반영됩니다</span>
              : (<div>
                  <span className="badge">이 판은 랭킹에 반영되지 않습니다</span>
                  <ul className="muted" style={{ margin: '8px 0 0 18px' }}>
                    {room.eligibility.reasons.map((x) => <li key={x}>{x}</li>)}
                  </ul>
                </div>)}
          </div>
        </div>

        <div className="card col">
          <h2>룰</h2>
          <RulesGrid r={r} isHost={isHost} patch={patch}
            nonStandardLimit={room.eligibility.reasons.some((x) => x.startsWith('제한 시간'))} />
          <p className="muted" style={{ margin: 0 }}>
            빈칸을 다 채우고 제약 위반이 없으면 제출할 수 있고, <strong>제출은 곧 완주</strong>입니다.
            보드를 다 채우기 전까지는 어떤 칸이 맞았는지 알 수 없습니다.
          </p>
          {isHost && !room.eligibility.eligible && <button onClick={() => send({ t: 'rules:preset' })}>랭크 판으로 맞추기</button>}
        </div>

        <div className="card">
          <h2>참가자 {room.members.length}/{r.capacity}</h2>
          {room.members.map((m) => (
            <div key={m.accountId} className="progress-row">
              <span>{m.nickname} {m.isHost && <span className="badge">호스트</span>} {!m.connected && <span className="badge warn">연결 끊김</span>}</span>
              <span>{m.isHost ? '—' : m.ready ? <span className="badge ok">준비완료</span> : <span className="badge">미준비</span>}
                {isHost && !m.isHost && <button className="danger" style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}
                  onClick={() => send({ t: 'room:kick', accountId: m.accountId })}>내보내기</button>}
              </span>
            </div>
          ))}
          <div className="row" style={{ marginTop: 12 }}>
            {isHost
              ? <button className="primary" onClick={() => send({ t: 'match:start' })}>시작</button>
              : <button className="primary" onClick={() => send({ t: 'ready:toggle' })}>
                  {room.members.find((m) => m.accountId === me.accountId)?.ready ? '준비 해제' : '준비완료'}
                </button>}
            {room.phase === 'result' && isHost && <button onClick={() => send({ t: 'room:rematch' })}>다시 하기</button>}
            <button onClick={() => { send({ t: 'room:leave' }); say('룸에서 나왔습니다'); }}>나가기</button>
          </div>
        </div>
      </div>
      <ChatPanel chat={chat} disabled={false} />
    </div>
  );
}

/**
 * 룰 여섯 개를 3열 격자로 — 값이 몇 개 안 되는 항목은 세그먼트, 켜고 끄는 항목은 토글.
 * "표준값" 여부는 클라이언트가 계산하지 않고 서버의 랭크 자격 사유(AREA-ROOM §7)를 읽는다 —
 * 난이도별 표준 제한 시간표를 여기 한 벌 더 두면 언젠가 어긋난다.
 */
function RulesGrid({ r, isHost, patch, nonStandardLimit }: {
  r: Rules; isHost: boolean; patch: (p: Partial<Rules>, follow?: boolean) => void; nonStandardLimit: boolean;
}) {
  return (
    <div className="rules">
      <div className="rule-cell"><span className="k">모드</span>
        <Seg label="모드" value={r.mode} disabled={!isHost} onPick={(mode) => patch({ mode })}
          options={[{ v: 'race' as const, label: '레이스' }, { v: 'coop' as const, label: '협동' }]} /></div>
      <div className="rule-cell"><span className="k">난이도</span>
        <Seg tight label="난이도" value={r.difficulty} disabled={!isHost} onPick={(difficulty) => patch({ difficulty })}
          options={(Object.keys(DIFF_LABEL) as Difficulty[]).map((k) => ({ v: k, label: DIFF_LABEL[k]! }))} /></div>
      <div className="rule-cell"><span className="k">정원</span>
        <Seg label="정원" value={r.capacity} disabled={!isHost} onPick={(capacity) => patch({ capacity })}
          options={[2, 3, 4, 5, 6, 7, 8].map((n) => ({ v: n, label: String(n) }))} /></div>
      <div className="rule-cell"><span className="k">제한 시간</span>
        <div className="lim">
          <input type="number" min={3} max={60} disabled={!isHost} value={Math.round(r.limitSec / 60)} aria-label="제한 시간(분)"
            onChange={(e) => patch({ limitSec: Number(e.target.value) * 60 }, false)} />
          <span className="k">분{!nonStandardLimit && ' · 표준값'}</span>
          {nonStandardLimit && <button className="ghost sm" disabled={!isHost} onClick={() => patch({}, true)}>표준값으로</button>}
        </div></div>
      <div className="rule-cell"><span className="k">제약 위반 표시</span>
        <Switch label="제약 위반 표시" on={r.violationDisplay === 'show'} disabled={!isHost} onLabel="표시" offLabel="숨김"
          onToggle={(on) => patch({ violationDisplay: on ? 'show' : 'hide' })} /></div>
      <div className="rule-cell"><span className="k">힌트 허용</span>
        <Switch label="힌트 허용" on={r.hintsAllowed} disabled={!isHost} onLabel="허용" offLabel="비허용"
          onToggle={(on) => patch({ hintsAllowed: on })} /></div>
    </div>
  );
}

function Seg<T extends string | number>({ value, options, disabled, onPick, tight, label }: {
  value: T; options: { v: T; label: string }[]; disabled: boolean; onPick: (v: T) => void; tight?: boolean; label: string;
}) {
  return (
    <div className={tight ? 'seg tight' : 'seg'} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} type="button" aria-pressed={o.v === value} disabled={disabled}
          onClick={() => { if (o.v !== value) onPick(o.v); }}>{o.label}</button>
      ))}
    </div>
  );
}

function Switch({ on, disabled, onToggle, onLabel, offLabel, label }: {
  on: boolean; disabled: boolean; onToggle: (on: boolean) => void; onLabel: string; offLabel: string; label: string;
}) {
  return (
    <button type="button" className="switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={() => onToggle(!on)}><i aria-hidden />{on ? onLabel : offLabel}</button>
  );
}

// ── 진행률 · 채팅 · 랭킹 ─────────────────────────────────────────────────────
function ProgressPanel({ progress, match, me }: { progress: Progress | null; match: MatchStarted; me: Me }) {
  const of = (id: string) => match.participants.find((p) => p.accountId === id);
  const nick = (id: string) => of(id)?.nickname ?? id;
  const blanks = match.givens.filter((v) => !v).length || 1;
  /* 아바타 색은 참가자 색인을 따른다 — 협동의 칸 소유 표시와 같은 색이라 눈이 이어진다 */
  const hue = (id: string) => AVATAR_COLORS[(of(id)?.colorIndex ?? 0) % AVATAR_COLORS.length]!;

  return (
    <div className="panel">
      <div className="hd"><h2>진행률</h2><span className="muted">0.5초마다</span></div>
      <div className="bd" style={{ padding: '4px 16px 12px' }}>
        {!progress && <p className="muted" style={{ padding: '8px 0' }}>곧 갱신됩니다…</p>}

        {progress?.kind === 'race' && progress.participants.map((p) => (
          <div key={p.accountId} className="progress-row">
            <span className="avatar" style={{ background: hue(p.accountId) }} aria-hidden>{nick(p.accountId).slice(0, 1)}</span>
            <span className="nm">
              {nick(p.accountId)}{p.accountId === me.accountId && <span className="muted"> (나)</span>}
            </span>
            {p.left ? <span className="badge no">이탈</span>
              : !p.connected ? <span className="badge warn">연결 끊김</span>
              : p.finished ? <span className="badge ok">완주</span>
              : <>
                  <span className="bar"><i style={{ width: `${Math.min(100, (p.filled / blanks) * 100)}%` }} /></span>
                  <span className="num" style={{ fontSize: 12.5 }}>{p.filled}칸</span>
                </>}
          </div>
        ))}

        {progress?.kind === 'coop' && (
          <>
            <div className="progress-row">
              <span className="nm"><strong>팀</strong></span>
              {progress.team.finished ? <span className="badge ok">완주</span> : <>
                <span className="bar"><i style={{ width: `${Math.min(100, (progress.team.filled / blanks) * 100)}%` }} /></span>
                <span className="num" style={{ fontSize: 12.5 }}>{progress.team.filled}칸</span>
              </>}
            </div>
            {progress.members.map((m) => (
              <div key={m.accountId} className="progress-row">
                <span className="avatar" style={{ background: hue(m.accountId) }} aria-hidden>{nick(m.accountId).slice(0, 1)}</span>
                <span className="nm">{nick(m.accountId)}{m.accountId === me.accountId && <span className="muted"> (나)</span>}</span>
                {m.left ? <span className="badge no">이탈</span> : !m.connected ? <span className="badge warn">연결 끊김</span> : null}
              </div>
            ))}
          </>
        )}

        <p className="muted" style={{ margin: '10px 0 0', lineHeight: 1.5 }}>
          미완주자끼리의 위치는 <strong>채운 칸 수 기준, 잠정</strong>입니다 — 최종 순위는 정답 칸 수로 갈립니다.
        </p>
      </div>
    </div>
  );
}

function ChatPanel({ chat, disabled }: { chat: ChatMessage[]; disabled: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [chat]);
  return (
    <div className="card col">
      <h2>채팅</h2>
      <div className="chat" ref={ref}>
        {chat.map((m) => (
          <div key={m.id} className={m.kind === 'system' ? 'sys' : ''}>
            {m.kind === 'user' ? <><strong>{m.nickname}</strong> {m.text}</> : m.text}
          </div>
        ))}
      </div>
      <div className="row">
        <input value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }}
          placeholder={disabled ? '랭크 레이스 판은 진행 중 닫힙니다 — 결과 화면에서 다시 열립니다' : '메시지'}
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { send({ t: 'chat:send', text }); setText(''); } }} />
        <button disabled={disabled || !text.trim()} onClick={() => { send({ t: 'chat:send', text }); setText(''); }}>보내기</button>
      </div>
    </div>
  );
}

/** 랭킹 화면이 서버에서 받는 모양. `api<never>` 로 두면 이 파일의 오타를 타입 검사가 놓친다. */
interface RankingBoards {
  rating: { nickname: string; rating: number }[];
  season: { nickname: string; points: number }[];
  seasonIndex: number;
  brackets: string[];
}
interface RecordRowView { adjustedFinishSec: number; holders: { nickname: string }[] }

function Rankings({ me }: { me: Me }) {
  const [data, setData] = useState<RankingBoards | null>(null);
  const [records, setRecords] = useState<RecordRowView[]>([]);
  const [bracket, setBracket] = useState('race:normal');
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    void api<RankingBoards>('/api/rankings').then((r) => {
      if (!r.ok) { setFailed(`랭킹을 불러오지 못했습니다 (${r.status})`); return; }
      setData(r.data);
    });
  }, []);
  useEffect(() => {
    void api<RecordRowView[]>(`/api/records?bracket=${bracket}`).then((r) => r.ok && setRecords(r.data));
  }, [bracket]);
  if (failed) return <p className="muted" style={{ color: 'var(--danger)' }}>{failed}</p>;
  if (!data) return <p className="muted">불러오는 중…</p>;
  const mine = (names: string[]) => names.includes(me.nickname);
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>랭킹</h1>
          <p className="muted" style={{ margin: 0 }}>시즌 <span className="num">{data.seasonIndex}</span> · 4주마다 초기화됩니다</p>
        </div>
      </div>
      {/* 세 축을 나란히 — 레이팅·시즌 포인트는 통합 1벌, 기록만 브래킷별이다(DSN-RANKING R6) */}
      <div className="hairgrid">
        <section>
          <div className="hd"><h2>레이팅</h2><span className="muted">통합</span></div>
          {data.rating.length === 0 && <div className="empty" style={{ marginTop: 14 }}>배치 <b className="num">5</b>판을 마친 사람이<br />아직 없습니다</div>}
          {data.rating.map((x, i) => <RankRow key={x.nickname} i={i} names={[x.nickname]} mine={mine([x.nickname])} value={String(x.rating)} />)}
        </section>
        <section>
          <div className="hd"><h2>시즌 포인트</h2><span className="muted">시즌 {data.seasonIndex}</span></div>
          {data.season.length === 0 && <div className="empty" style={{ marginTop: 14 }}>아직 집계된 판이 없습니다</div>}
          {data.season.map((x, i) => <RankRow key={x.nickname} i={i} names={[x.nickname]} mine={mine([x.nickname])} value={String(x.points)} />)}
        </section>
        <section>
          <div className="hd"><h2>기록</h2>
            <select value={bracket} onChange={(e) => setBracket(e.target.value)} aria-label="브래킷">
              {data.brackets.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          {records.length === 0 && <div className="empty" style={{ marginTop: 14 }}>이 보드는 아직 비어 있습니다</div>}
          {records.map((x, i) => {
            const names = x.holders.map((h) => h.nickname);
            return <RankRow key={i} i={i} names={names} mine={mine(names)} value={fmtSec(x.adjustedFinishSec)} />;
          })}
        </section>
      </div>
    </>
  );
}

function RankRow({ i, names, mine, value }: { i: number; names: string[]; mine: boolean; value: string }) {
  return (
    <div className={`progress-row${mine ? ' me' : ''}`}>
      <span className={`rk${i === 0 ? ' first' : ''}`}>{i + 1}</span>
      <span className="nm">{names.join(', ')}{mine && <span className="muted"> (나)</span>}</span>
      <span className="num" style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
// ── 결과 ────────────────────────────────────────────────────────────────────
function Result({ ended, me, onClose, isHost }: { ended: MatchEnded; me: Me; onClose: () => void; isHost: boolean }) {
  const mine = ended.boards.find((b) => b.accountId === me.accountId)?.cells ?? [];
  const reason = { 'all-finished': '전원 완주', 'time-expired': '제한 시간 만료', 'membership-empty': '남은 참가자 없음' }[ended.endReason];
  return (
    <div className="card col" style={{ marginBottom: 20, borderColor: 'var(--accent)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>결과 — {reason}</h2>
        <div className="row">
          <span className={ended.rankEligible ? 'badge rank' : 'badge'}>{ended.rankEligible && <i className="dot" />}{ended.rankEligible ? '랭킹 반영' : '캐주얼'}</span>
          {isHost && <button onClick={() => { send({ t: 'room:rematch' }); onClose(); }}>다시 하기</button>}
          <button onClick={onClose}>닫기</button>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            {ended.mode === 'race' && <th>순위</th>}
            <th>이름</th><th>완주</th><th className="n">조정 완주 시각</th><th className="n">정답 칸</th>
            {ended.mode === 'race' && <th className="n">포인트</th>}
            {ended.mode === 'race' && <th className="n">레이팅</th>}
            {ended.mode === 'coop' && <th className="n">기여</th>}
          </tr>
        </thead>
        <tbody>
          {ended.participants.map((p) => (
            <tr key={p.accountId} className={p.accountId === me.accountId ? 'me' : undefined}>
              {ended.mode === 'race' && <td><span className={`rk${p.rank === 1 ? ' first' : ''}`}>{p.rank}</span></td>}
              <td>{p.nickname}{p.left && <span className="badge no" style={{ marginLeft: 6 }}>{p.kicked ? '강퇴됨' : '이탈'}</span>}</td>
              <td>{p.finished ? <span style={{ color: 'var(--good)' }}>✓</span> : <span style={{ color: 'var(--ink3)' }}>—</span>}</td>
              <td className="n">{p.adjustedFinishSec !== null ? fmtSec(p.adjustedFinishSec) : '—'}</td>
              <td className="n">{p.correctCells}</td>
              {ended.mode === 'race' && <td className="n">{p.rankPoint}</td>}
              {ended.mode === 'race' && (
                <td className="n" style={{ color: p.ratingDelta ? (p.ratingDelta > 0 ? 'var(--good)' : 'var(--danger)') : 'var(--ink3)' }}>
                  {p.ratingDelta === null ? '—' : (p.ratingDelta > 0 ? `+${p.ratingDelta}` : p.ratingDelta)}
                </td>
              )}
              {ended.mode === 'coop' && <td className="n">{p.contribution}/{p.requiredContribution} {p.gatePassed ? '✓' : <span className="badge no">미달</span>}</td>}
            </tr>
          ))}
        </tbody>
      </table>

      {ended.team && (
        <p className="muted" style={{ margin: 0 }}>
          팀 포인트 <strong className="num">{ended.team.teamPoint}</strong>
          {ended.team.adjustedFinishSec !== null && <> · 조정 완주 시각 <span className="num">{fmtSec(ended.team.adjustedFinishSec)}</span></>}
        </p>
      )}

      <div>
        <h3>정답 보드와 내 보드</h3>
        <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <div className="col" style={{ gap: 6 }}>
            <span className="muted">정답</span>
            <MiniBoard cells={ended.solutionRevealed} compare={null} />
          </div>
          <div className="col" style={{ gap: 6 }}>
            <span className="muted">내 보드 — 틀린 칸이 표시됩니다</span>
            <MiniBoard cells={mine} compare={ended.solutionRevealed} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniBoard({ cells, compare }: { cells: number[]; compare: number[] | null }) {
  return (
    <div className="board" style={{ width: 'min(84vw,260px)' }}>
      {Array.from({ length: 81 }, (_, i) => {
        const wrong = compare !== null && cells[i] !== compare[i];
        return (
          <div key={i} className={`cell${wrong ? ' bad' : ''}${i >= 9 && Math.floor(i / 9) % 3 === 0 ? ' r3' : ''}${i % 9 !== 0 && (i % 9) % 3 === 0 ? ' c3' : ''}`}
            style={{ fontSize: 12 }}>
            {cells[i] || ''}
          </div>
        );
      })}
    </div>
  );
}
