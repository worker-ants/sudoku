'use client';
export function Keypad({ onKey, disabled }: { onKey: (v: number) => void; disabled?: boolean }) {
  return (
    <div className="keypad">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
        <button key={n} disabled={disabled} onClick={() => onKey(n)} aria-label={`${n} 입력`}>{n}</button>
      ))}
      <button disabled={disabled} onClick={() => onKey(0)} aria-label="지우기">지움</button>
    </div>
  );
}
