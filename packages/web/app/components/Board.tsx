'use client';
import { COLORS } from '../../lib/sudoku';

export interface BoardProps {
  givens: number[]; cells: number[]; selected: number | null;
  violations: Set<number>; showViolations: boolean;
  hintIndex: number | null; peers: Set<number>;
  owners?: Record<number, string>;                 // 협동 — 칸별 마지막 입력자
  colorOf?: (accountId: string) => number;
  cursors?: { accountId: string; index: number | null; nickname: string }[];
  readOnly?: boolean;
  onSelect: (i: number) => void;
}

export function Board(p: BoardProps) {
  return (
    <div className="board" role="grid" aria-label="스도쿠 보드">
      {Array.from({ length: 81 }, (_, i) => {
        const given = p.givens[i]! > 0;
        const v = given ? p.givens[i]! : (p.cells[i] ?? 0);
        const bad = p.showViolations && p.violations.has(i);
        const owner = p.owners?.[i];
        const cur = p.cursors?.filter((c) => c.index === i) ?? [];
        const cls = [
          'cell',
          given ? 'given' : '',
          p.selected === i ? 'sel' : p.peers.has(i) ? 'peer' : '',
          bad ? 'bad' : '',
          p.hintIndex === i ? 'hint' : '',
          i >= 9 && Math.floor(i / 9) % 3 === 0 ? 'r3' : '',
          i % 9 !== 0 && (i % 9) % 3 === 0 ? 'c3' : '',
        ].filter(Boolean).join(' ');
        return (
          <button key={i} className={cls} disabled={p.readOnly || given}
            aria-label={`${Math.floor(i / 9) + 1}행 ${(i % 9) + 1}열${v ? ` ${v}` : ' 빈칸'}`}
            data-idx={i}
            onClick={() => p.onSelect(i)}>
            {v || ''}
            {owner && !given && p.colorOf && (
              <span className="owner" style={{ background: COLORS[p.colorOf(owner) % COLORS.length] }} />
            )}
            {cur.length > 0 && <span className="cursor" title={cur.map((c) => c.nickname).join(', ')}>▾</span>}
          </button>
        );
      })}
    </div>
  );
}
