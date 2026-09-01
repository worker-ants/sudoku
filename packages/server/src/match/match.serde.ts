/** MatchState 는 Map 을 갖는다 — 저장소로 나갈 때 배열로 편다 */
import type { MatchState, ParticipantState, TeamState } from '@sudoku/core';

export interface StoredMatch {
  base: Omit<MatchState, 'participants' | 'team'>;
  participants: [string, ParticipantState][];
  team: (Omit<TeamState, 'firstEntry' | 'changeLog'> & {
    firstEntry: [number, [number, string][]][];
    changeLog: [number, { value: number; by: string; atMs: number }[]][];
  }) | null;
}

export function toStored(m: MatchState): StoredMatch {
  const { participants, team, ...base } = m;
  return {
    base,
    participants: [...participants.entries()],
    team: team
      ? {
          ...team,
          firstEntry: [...team.firstEntry.entries()].map(([k, v]) => [k, [...v.entries()]] as [number, [number, string][]]),
          changeLog: [...team.changeLog.entries()],
        }
      : null,
  };
}

export function fromStored(s: StoredMatch): MatchState {
  return {
    ...s.base,
    participants: new Map(s.participants),
    team: s.team
      ? {
          ...s.team,
          firstEntry: new Map(s.team.firstEntry.map(([k, v]) => [k, new Map(v)])),
          changeLog: new Map(s.team.changeLog),
        }
      : null,
  };
}
