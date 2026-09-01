'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatMessage, LobbyRoomView, MatchEnded, MatchStarted, Progress, RoomView, ServerMessage, SubmitResult, SubmitWindow,
} from '@sudoku/contracts';
import { api, connect, disconnect, send } from '../lib/net';
import { DIFF_LABEL, fmtSec, isFull, peersOf, violations } from '../lib/sudoku';
import { Board } from './components/Board';
import { Keypad } from './components/Keypad';

type Me = { accountId: string; nickname: string; email: string };

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

  const say = useCallback((t: string) => { setToast(t); setTimeout(() => setToast((x) => (x === t ? null : x)), 3200); }, []);

  const onMessage = useCallback((m: ServerMessage) => {
    switch (m.t) {
      case 'room:state': setRoom(m.room); if (m.room.phase !== 'playing') { setMatch(null); setWindow_(null); } return;
      case 'room:closed': setRoom(null); setMatch(null); setEnded(null); say(m.reason); return;
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
    <div className="wrap">
      <header className="row" style={{ justifyContent: 'space-between', marginBottom: 20 }}>
        <div className="row" style={{ gap: 10 }}>
          <h1 style={{ fontSize: 22 }}>스도쿠</h1>
          <span className="badge">{me.nickname}</span>
        </div>
        <div className="row">
          {!room && <button onClick={() => setView(view === 'lobby' ? 'rankings' : 'lobby')}>{view === 'lobby' ? '랭킹' : '로비'}</button>}
          <button onClick={async () => { await api('/api/auth/logout', 'POST'); disconnect(); setMe(null); setRoom(null); }}>로그아웃</button>
        </div>
      </header>

      {toast && <div className="toast" role="status">{toast}</div>}

      {ended && <Result ended={ended} me={me} onClose={() => setEnded(null)} isHost={room?.members.find((x) => x.accountId === me.accountId)?.isHost ?? false} />}

      {!room && view === 'lobby' && <Lobby lobby={lobby} onEnter={setRoom} say={say} />}
      {!room && view === 'rankings' && <Rankings />}

      {room && !match && !ended && <RoomPanel room={room} me={me} chat={chat} say={say} />}

      {room && match && (
        <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
          <div className="col">
            <div className="row" style={{ justifyContent: 'space-between', width: 'min(92vw,468px)' }}>
              <strong className="num" aria-label="남은 시간">{fmtSec(remainSec)}</strong>
              <span className="muted">
                {DIFF_LABEL[match.difficulty]} · {match.mode === 'race' ? '레이스' : '협동'} ·{' '}
                <span className={match.rankEligible ? 'badge ok' : 'badge no'}>{match.rankEligible ? '랭킹 반영' : '캐주얼'}</span>
              </span>
            </div>
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
            <div className="row">
              <button className="primary"
                disabled={locked || !isFull(cells) || bad.size > 0}
                onClick={() => send({ t: 'submit:request' })}>
                제출
              </button>
              {match.hintsAllowed && (
                <button disabled={locked || isFull(cells) || (hint ? hint.used >= hint.limit : false)}
                  onClick={() => send({ t: 'hint:request' })}>
                  힌트 {hint ? `${hint.limit - hint.used}/${hint.limit}` : `${match.mode === 'coop' ? '팀 ' : ''}3회`}
                </button>
              )}
              <button className="danger" onClick={() => { if (confirm('이 판의 결과는 지금 상태로 확정되어 결과와 랭킹에 반영됩니다.\n이 판에는 다시 들어올 수 없습니다.')) send({ t: 'room:leave' }); }}>나가기</button>
            </div>
            {!isFull(cells) && <p className="muted">빈칸 {cells.filter((v, i) => !match.givens[i] && !v).length}개</p>}
            {isFull(cells) && bad.size > 0 && <p className="muted" style={{ color: 'var(--danger)' }}>제출할 수 없습니다 — 같은 줄이나 칸에 같은 숫자가 있습니다</p>}
          </div>

          <div className="col" style={{ flex: 1, minWidth: 260 }}>
            <ProgressPanel progress={progress} match={match} me={me} />
            <ChatPanel chat={chat} disabled={match.mode === 'race' && match.rankEligible} />
          </div>
        </div>
      )}

      {window_ && (
        <div className="banner" role="alertdialog">
          <p style={{ margin: 0, fontSize: 17 }}>
            <strong>{window_.byNickname}</strong>님이 제출을 요청했습니다 —{' '}
            <span className="num">{Math.max(0, Math.ceil((window_.endsAtEpochMs - serverNow) / 1000))}</span>
          </p>
          {window_.isLastSubmit && <p style={{ color: 'var(--danger)', margin: '8px 0 0' }}>마지막 제출입니다. 실패하면 이 판은 완주할 수 없습니다.</p>}
          <button className="danger" style={{ marginTop: 14, padding: '12px 28px', fontSize: 16 }}
            onClick={() => send({ t: 'submit:cancel' })}>취소</button>
        </div>
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
    <div className="wrap" style={{ maxWidth: 420 }}>
      <h1>스도쿠</h1>
      <p className="muted">여럿이 함께 푸는 스도쿠</p>
      <div className="card col" style={{ marginTop: 20 }}>
        <div className="row">
          <button className={mode === 'signup' ? 'primary' : ''} onClick={() => setMode('signup')}>가입</button>
          <button className={mode === 'login' ? 'primary' : ''} onClick={() => setMode('login')}>로그인</button>
        </div>
        {mode === 'signup' && (
          <label className="col" style={{ gap: 4 }}>닉네임
            <input value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} placeholder="2~16자" />
          </label>
        )}
        <label className="col" style={{ gap: 4 }}>이메일
          <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="로그인 ID 로만 쓰입니다" />
        </label>
        <label className="col" style={{ gap: 4 }}>비밀번호
          <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="8자 이상" />
        </label>
        {err && <p style={{ color: 'var(--danger)', margin: 0 }}>{err}</p>}
        <button className="primary" onClick={submit}>{mode === 'signup' ? '가입하고 시작' : '로그인'}</button>
        <p className="muted" style={{ margin: 0 }}>
          ※ 비밀번호 찾기는 아직 지원하지 않습니다. 이메일은 로그인 ID 로만 쓰이며, 어떤 메일도 보내지 않습니다.
        </p>
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
    <div className="col">
      <div className="row">
        <button className="primary" onClick={create}>룸 만들기</button>
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="코드 6자리" maxLength={6} style={{ width: 140 }} />
        <button onClick={() => join(code)} disabled={code.length !== 6}>코드로 참가</button>
      </div>
      <div className="card">
        <h2>공개 룸</h2>
        {lobby.length === 0 && <p className="muted">아직 열린 룸이 없습니다. 하나 만들어 보세요.</p>}
        {lobby.length > 0 && (
          <table>
            <thead><tr><th>이름</th><th>모드</th><th>난이도</th><th>인원</th><th>랭크</th><th>상태</th><th /></tr></thead>
            <tbody>
              {lobby.map((r) => (
                <tr key={r.roomId}>
                  <td>{r.name}<div className="muted">{r.hostNickname}</div></td>
                  <td>{r.mode === 'race' ? '레이스' : '협동'}</td>
                  <td>{DIFF_LABEL[r.difficulty]}</td>
                  <td className="num">{r.count}/{r.capacity}</td>
                  <td><span className={r.rankEligible ? 'badge ok' : 'badge no'}>{r.rankEligible ? '반영' : '캐주얼'}</span></td>
                  <td>{r.phase === 'playing' ? <span className="badge">진행 중 {r.endsInSec !== null ? fmtSec(r.endsInSec) : ''}</span> : r.phase === 'result' ? '결과' : '대기'}</td>
                  <td><button disabled={r.phase === 'playing' || r.count >= r.capacity} onClick={() => join(r.code)}>참가</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── 룸 ──────────────────────────────────────────────────────────────────────
function RoomPanel({ room, me, chat, say }: { room: RoomView; me: Me; chat: ChatMessage[]; say: (s: string) => void }) {
  const isHost = room.members.find((m) => m.accountId === me.accountId)?.isHost ?? false;
  const r = room.rules;
  const patch = (p: Partial<typeof r>, follow?: boolean) => send({ t: 'rules:update', patch: p, followStandardLimit: follow });
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
      <div className="col" style={{ flex: 1, minWidth: 320 }}>
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{room.name}</h2>
            <span className="badge">코드 {room.code}</span>
          </div>
          <div style={{ marginTop: 10 }}>
            {room.eligibility.eligible
              ? <span className="badge ok">이 판은 랭킹에 반영됩니다</span>
              : (<div>
                  <span className="badge no">이 판은 랭킹에 반영되지 않습니다</span>
                  <ul className="muted" style={{ margin: '8px 0 0 18px' }}>
                    {room.eligibility.reasons.map((x) => <li key={x}>{x}</li>)}
                  </ul>
                </div>)}
          </div>
        </div>

        <div className="card col">
          <h2>룰</h2>
          <div className="row">
            <label>모드
              <select disabled={!isHost} value={r.mode} onChange={(e) => patch({ mode: e.target.value as 'race' | 'coop' })}>
                <option value="race">레이스</option><option value="coop">협동</option>
              </select>
            </label>
            <label>난이도
              <select disabled={!isHost} value={r.difficulty} onChange={(e) => patch({ difficulty: e.target.value as never })}>
                {Object.entries(DIFF_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>정원
              <select disabled={!isHost} value={r.capacity} onChange={(e) => patch({ capacity: Number(e.target.value) })}>
                {[2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <label>제한 시간
              <input type="number" min={3} max={60} disabled={!isHost} value={Math.round(r.limitSec / 60)}
                onChange={(e) => patch({ limitSec: Number(e.target.value) * 60 }, false)} style={{ width: 80 }} /> 분
            </label>
            <button disabled={!isHost} onClick={() => patch({}, true)}>표준값으로</button>
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" disabled={!isHost} checked={r.violationDisplay === 'show'}
                onChange={(e) => patch({ violationDisplay: e.target.checked ? 'show' : 'hide' })} /> 제약 위반 표시
            </label>
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" disabled={!isHost} checked={r.hintsAllowed}
                onChange={(e) => patch({ hintsAllowed: e.target.checked })} /> 힌트 허용
            </label>
          </div>
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
              <span>{m.nickname} {m.isHost && <span className="badge">호스트</span>} {!m.connected && <span className="badge no">연결 끊김</span>}</span>
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
      <div style={{ flex: 1, minWidth: 260 }}><ChatPanel chat={chat} disabled={false} /></div>
    </div>
  );
}

// ── 진행률 · 채팅 · 랭킹 ─────────────────────────────────────────────────────
function ProgressPanel({ progress, match, me }: { progress: Progress | null; match: MatchStarted; me: Me }) {
  const nick = (id: string) => match.participants.find((p) => p.accountId === id)?.nickname ?? id;
  return (
    <div className="card">
      <h2>진행률</h2>
      {!progress && <p className="muted">곧 갱신됩니다…</p>}
      {progress?.kind === 'race' && progress.participants.map((p) => (
        <div key={p.accountId} className="progress-row">
          <span>{nick(p.accountId)}{p.accountId === me.accountId ? ' (나)' : ''}
            {p.left && <span className="badge no" style={{ marginLeft: 6 }}>이탈</span>}
            {!p.connected && !p.left && <span className="badge" style={{ marginLeft: 6 }}>연결 끊김</span>}</span>
          <span className="num">{p.finished ? <span className="badge ok">완주</span> : `${p.filled}칸`}</span>
        </div>
      ))}
      {progress?.kind === 'coop' && (
        <>
          <div className="progress-row"><span>팀</span>
            <span className="num">{progress.team.finished ? <span className="badge ok">완주</span> : `${progress.team.filled}칸`}</span></div>
          {progress.members.map((m) => (
            <div key={m.accountId} className="progress-row">
              <span>{nick(m.accountId)}{m.accountId === me.accountId ? ' (나)' : ''}</span>
              <span>{m.left ? <span className="badge no">이탈</span> : m.connected ? '' : <span className="badge">연결 끊김</span>}</span>
            </div>
          ))}
        </>
      )}
      <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
        미완주자끼리의 위치는 <strong>채운 칸 수 기준, 잠정</strong>입니다 — 최종 순위는 정답 칸 수로 갈립니다.
      </p>
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

function Rankings() {
  const [data, setData] = useState<{ rating: { nickname: string; rating: number }[]; season: { nickname: string; points: number }[]; brackets: string[] } | null>(null);
  const [records, setRecords] = useState<{ adjustedFinishSec: number; holders: { nickname: string }[] }[]>([]);
  const [bracket, setBracket] = useState('race:normal');
  useEffect(() => { void api<never>('/api/rankings').then((r) => r.ok && setData(r.data)); }, []);
  useEffect(() => { void api<never>(`/api/records?bracket=${bracket}`).then((r) => r.ok && setRecords(r.data)); }, [bracket]);
  if (!data) return <p className="muted">불러오는 중…</p>;
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: 1, minWidth: 240 }}>
        <h2>레이팅</h2>
        {data.rating.length === 0 && <p className="muted">배치 5판을 마친 사람이 아직 없습니다.</p>}
        {data.rating.map((x, i) => <div key={x.nickname} className="progress-row"><span>{i + 1}. {x.nickname}</span><span className="num">{x.rating}</span></div>)}
      </div>
      <div className="card" style={{ flex: 1, minWidth: 240 }}>
        <h2>시즌 포인트</h2>
        {data.season.length === 0 && <p className="muted">아직 집계된 판이 없습니다.</p>}
        {data.season.map((x, i) => <div key={x.nickname} className="progress-row"><span>{i + 1}. {x.nickname}</span><span className="num">{x.points}</span></div>)}
      </div>
      <div className="card" style={{ flex: 1, minWidth: 260 }}>
        <h2>기록</h2>
        <select value={bracket} onChange={(e) => setBracket(e.target.value)}>
          {data.brackets.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        {records.length === 0 && <p className="muted" style={{ marginTop: 8 }}>이 보드는 아직 비어 있습니다.</p>}
        {records.map((x, i) => (
          <div key={i} className="progress-row">
            <span>{i + 1}. {x.holders.map((h) => h.nickname).join(', ')}</span>
            <span className="num">{fmtSec(x.adjustedFinishSec)}</span>
          </div>
        ))}
      </div>
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
          <span className={ended.rankEligible ? 'badge ok' : 'badge no'}>{ended.rankEligible ? '랭킹 반영' : '캐주얼'}</span>
          {isHost && <button onClick={() => { send({ t: 'room:rematch' }); onClose(); }}>다시 하기</button>}
          <button onClick={onClose}>닫기</button>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            {ended.mode === 'race' && <th>순위</th>}
            <th>이름</th><th>완주</th><th>조정 완주 시각</th><th>정답 칸</th>
            {ended.mode === 'race' && <th>포인트</th>}
            {ended.mode === 'race' && <th>레이팅</th>}
            {ended.mode === 'coop' && <th>기여</th>}
          </tr>
        </thead>
        <tbody>
          {ended.participants.map((p) => (
            <tr key={p.accountId} style={p.accountId === me.accountId ? { fontWeight: 600 } : undefined}>
              {ended.mode === 'race' && <td className="num">{p.rank}</td>}
              <td>{p.nickname}{p.left && <span className="badge no" style={{ marginLeft: 6 }}>{p.kicked ? '강퇴됨' : '이탈'}</span>}</td>
              <td>{p.finished ? '✓' : '—'}</td>
              <td className="num">{p.adjustedFinishSec !== null ? fmtSec(p.adjustedFinishSec) : '—'}</td>
              <td className="num">{p.correctCells}</td>
              {ended.mode === 'race' && <td className="num">{p.rankPoint}</td>}
              {ended.mode === 'race' && <td className="num">{p.ratingDelta === null ? '—' : (p.ratingDelta > 0 ? `+${p.ratingDelta}` : p.ratingDelta)}</td>}
              {ended.mode === 'coop' && <td className="num">{p.contribution}/{p.requiredContribution} {p.gatePassed ? '✓' : <span className="badge no">미달</span>}</td>}
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
