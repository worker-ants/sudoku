# NERV 연동 — 이 저장소의 설정

로컬에서 도는 NERV(`http://localhost:8080`)의 **sudoku** 프로젝트에 이 저장소의 Claude Code 세션을 붙여 둔 것이다. 연동을 시험해 보려고 만든 토이 설정이므로, 값은 전부 로컬을 가리킨다.

## 무엇이 어디에 있나

| 파일 | 무엇 | git |
| --- | --- | --- |
| `.mcp.json` | MCP 서버 `nerv` — 도구 18종이 여기로 온다. 토큰·프로젝트는 `${NERV_TOKEN}`·`${NERV_PROJECT}` 로 받는다 | 커밋됨 |
| `.claude/settings.json` | 훅 6종(세션·도구·서브에이전트·정지·종료) · statusline. **비밀 값 없음** | 커밋됨 |
| `.claude/settings.local.json` | `NERV_SERVER`·`NERV_PROJECT`·`NERV_TOKEN` | **무시**(토큰) |
| `.nerv/env` | 같은 값을 파일로 — 훅 포워더·statusline·`nerv` CLI 가 읽는다 | **무시** |
| `.claude/skills/nerv-*/` | 스킬 6종(`next`·`spec`·`impl`·`question`·`import`·`review`) | 커밋됨 |
| `.claude/agents/nerv-spec-writer.md` | 스펙 초안 전용 서브에이전트 — **코드 쓰기 도구가 없다**(스펙을 코드에 맞추는 방향을 막는다) | 커밋됨 |

훅과 statusline은 NERV 저장소의 플러그인 스크립트를 **절대 경로로** 부른다(`/Volumes/project/private/nerv/codebase/plugin/`). 그 포워더가 `X-NERV-Agent: claude-code` 를 보내므로 세션이 `other` 가 아니라 **`claude-code`** 로 기록된다. 사내 마켓플레이스가 없는 로컬 시험이라 플러그인을 설치하는 대신 그 자리에서 쓴다 — 그래서 스킬 이름도 `/nerv:next` 가 아니라 **`/nerv-next`** 다(플러그인 네임스페이스가 없다).

## 플러그인이 바뀌면 — 사본을 다시 맞춘다

훅과 statusline은 절대 경로로 원본을 부르니 늘 최신이지만, **스킬과 서브에이전트는 복사해 온 사본이다** — 원본이 바뀌어도 저절로 따라오지 않는다. 원본이 바뀌면 이 저장소 루트에서 이렇게 맞춘다(이름 두 군데만 고친다: `name:` 앞의 `nerv-`, 본문의 `/nerv:x` → `/nerv-x`).

```bash
SRC=/Volumes/project/private/nerv/codebase/plugin
for s in next spec impl question review import; do
  mkdir -p ".claude/skills/nerv-$s"
  sed -e "1,10s/^name: $s$/name: nerv-$s/" -e 's|/nerv:\([a-z]*\)|/nerv-\1|g' \
    "$SRC/skills/$s/SKILL.md" > ".claude/skills/nerv-$s/SKILL.md"
done
sed 's|/nerv:\([a-z]*\)|/nerv-\1|g' "$SRC/agents/nerv-spec-writer.md" \
  > .claude/agents/nerv-spec-writer.md
```

statusline 은 원본을 그대로 부르므로 클레임이 없을 때 `/nerv:next` 라고 쓴다 — 여기서는 `/nerv-next` 로 읽는다(플러그인으로 설치하면 그대로 맞는 문구다).

훅은 사본이 아니라 **손으로 옮긴 목록**이다 — 원본 `hooks/hooks.json` 에 훅이 늘면 `.claude/settings.json` 에도 같은 항목을 더한다(원본은 `type:"http"`, 여기는 토큰 주입 포워더라 `type:"command"`).

## 토큰

- 발급 계정: **`admin@example.com`**(이 프로젝트의 admin) · 이름 `sudoku/claude-code (admin)` · 프로젝트 `sudoku`
- 스코프 **9종 전부**: `spec:read` `spec:draft` `spec:meta` `task:claim` `task:update` `review:submit` `review:resolve` `agent-session:launch` `import:write`
- **`spec:approve` 와 `approval:decide` 는 토큰에 실을 수 없다.** 빠뜨린 것이 아니라 설계다 — 승인과 결정은 사람이 하고, 대응하는 MCP 도구 자체가 카탈로그에 없다.
- **그렇다고 에이전트의 제출이 승인 앞에서 멈추는 것은 아니다.** 아래 "제출이 곧 승인이 되는 경우"를 먼저 읽는다.

### 제출이 곧 승인이 되는 경우 — 게이트 티어 (2026-08-31 정정)

**이전 버전은 이 자리에 "에이전트는 `nerv_spec_submit_review` 로 제출까지 하고 멈춘다"고 적었다. 그 문장은 T2·T3 에서만 참이다.**

서버는 제출을 받으면 **게이트 티어**를 매기고, `T0`·`T1` 이면 같은 트랜잭션에서 **승인까지 한다**(`apps/api/src/modules/spec/spec.service.ts:694` — `if (gate.autoPass)`). 승인자는 `null` 로 남는다. 사람이 결정하는 것은 `T2`·`T3` 뿐이고, 그때만 **받은 요청**에 카드가 생긴다.

티어는 4축 점수(부작용 · 민감도 · 가역성 · 영향 범위, 각 0~2)의 합으로 갈린다 — `≤1` T0 · `≤3` T1 · `≤5` T2 · 그 위 T3(`apps/api/src/modules/spec/gate-tier.ts`).

**자동 통과는 버그가 아니라 의도된 기능이다.** 그 파일의 머리주석이 근거를 적어 두었다 — 모든 변경에 승인을 요구하면 "버그 하나 고치는 데 인수 기준 16개"라는 워터폴 회귀가 되고, 반사적 승인(consent fatigue)은 그 자체가 취약점이라는 것이다.

**이 저장소에서 실제로 겪은 것 (2026-08-31).** 교차 검토 수정 뒤 스펙 15편을 제출했더니 **13편이 즉시 `approved`, 규약 2편만 `in_review`** 가 되었다. 갈린 이유는 문서 타입이다.

| | 부작용 | 민감도 | 가역성 | 영향 범위 | 합 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| feature · design 8편 | 0 | 1 | 0 | 2 | **3 → T1** | 자동 승인 |
| vision · area 5편 | 0 | 0 | 0 | 2 | **2 → T1** | 자동 승인 |
| convention 2편 | 2 | 1 | 1 | 0~2 | **4 이상 → T2** | 승인 대기 |

- **부작용 0점**은 이 프로젝트의 스펙에 `requirement` 레코드가 한 건도 없기 때문이다. 본문만 바뀌면 0점이다.
- **convention·adr 은 타입만으로 부작용 2점 · 가역성 1점**을 받는다(`gate-tier.ts:110`·`:117`·`:129`). 규약 2편이 갈린 것은 내용이 아니라 타입 때문이다.
- **영향 범위 2점**은 참조 6건 이상이라는 뜻이다 — 2026-08-30 에 링크를 이어 관계를 89건으로 만든 결과가 여기에 들어온다.

**되돌리는 경로는 없다.** `approve` 와 `reject` 는 둘 다 `in_review` 를 요구하므로 이미 `approved` 인 버전에는 쓸 수 없다(`spec.service.ts:756`·`787`). T1 의 **"24시간 이의제기 창"은 `gate-tier.ts:84` 에 값으로만 있고 api·web 어디에도 동작이 구현돼 있지 않다.** 앞으로 고치는 것은 막히지 않는다 — 새 draft(v2)를 올리면 승인 시 v1 이 `superseded` 로 밀린다.

**`in_review` 인 버전에 `nerv_spec_draft_upsert` 를 부르면 그 버전이 고쳐지는 것이 아니라 다음 버전이 draft 로 갈라져 나온다**(응답이 `created:true` · `version_no:2` · 2026-08-31 확인). 앞 버전은 `in_review` 인 채로 승인 큐에 남으므로 **받은 요청의 카드를 누르면 낡은 쪽이 승인된다.** 제출한 문서를 고쳤으면 앞 버전을 거절하든 새 버전을 제출하든 한쪽으로 정리한다.

**그래서 제출 전에 확인할 것.** 스펙 타입과 참조 수로 티어를 어림잡고, 사람 결정을 반드시 거쳐야 하는 변경이면 **제출하지 않고 사람에게 올린다.** "제출은 안전하다"는 전제로 부르면 안 되는 도구다.

토큰을 다시 보고 싶으면 볼 수 없다(발급 시 1회만 표시). 다시 필요하면 NERV 웹의 **설정 → 에이전트 토큰**에서 새로 발급하고 `.nerv/env` 와 `.claude/settings.local.json` 두 곳을 같이 고친다.

## 서버 쪽이 바뀐 것 (2026-08-30)

플러그인 파일(스킬·서브에이전트·훅·statusline)은 그대로다 — **바뀐 것은 도구가 지키는 계약**이고, 시험 세션에서 걸렸던 것들이 여기 있다.

| 무엇 | 전 | 후 |
| --- | --- | --- |
| **세션** | `nerv_question_create`·`nerv_task_claim`·`nerv_session_event` 가 `session_required` 로 거부됐다(bootstrap 이 방금 성공했어도). 카탈로그는 그 도구들에 `session_id` 를 적지 않는데 **서버의 세션 추정이 구현돼 있지 않았다** | 이 토큰의 **살아 있는 세션이 하나면 그것으로** 해소한다. 스킬대로 부르면 된다. 한 토큰으로 세션 여럿이 동시에 살아 있으면 서버가 고르지 않고 후보를 준다(`session_ambiguous`) — 그때만 `session_id` 를 실어 다시 부른다 |
| **질문의 출처·사유** | 스킬이 지시하는 `context{spec_id,task_id,finding_id}`·`escalate`·`blocking`·`wait_seconds` 를 도구가 받지 않고 **조용히 버렸다** | 넷 다 받는다. 출처는 **키든 UUID 든** 해석하고, 못 찾으면 어느 항목인지 말한다(`details.field`). `wait_seconds` 는 최대 60초 long-poll |
| **참조 식별자** | `nerv_spec_get` 은 키를, `nerv_spec_draft_upsert` 는 UUID 를 받았다 | `spec_id`·`parent_id`·`task_id`·`scope.spec_ids` 가 **둘 다** 받는다 |
| **받은 요청 화면** | 질문의 선택지가 화면에 그려지지 않아 사람이 자유 서술로만 답했다 | 선택지가 **버튼**이고 누른 값이 `answer_key` 로 그대로 간다. 출처(스펙·작업)는 링크, 사유는 카드에 표시된다 |

그래서 **인수인계 문서의 "도구 함정" 목록은 더 이상 유효하지 않다** — 세션 인자를 손으로 챙기거나 UUID 를 따로 받아 둘 필요가 없다.

## 문서를 서로 잇는 법 (2026-08-30)

**관계는 본문의 링크에서만 만들어진다.** 다른 문서를 가리킬 때는 링크로 쓴다 — 산문에 키를 적거나 "게임플레이 §3"처럼 제목으로 부르면 관계가 생기지 않는다.

```markdown
([게임플레이](/p/sudoku/specs/SUD-AREA-PLAY) §3)
```

웹 편집기에는 **[스펙 링크]** 버튼이 있어 목록에서 골라 넣을 수 있고, 에이전트는 `nerv_spec_draft_upsert` 응답의 `relations`(added·removed·**unknown**)로 이어졌는지 확인한다. 정제·선행 같은 판단 관계는 본문에 적히지 않으므로 저장할 때 `relations: [{to, kind}]` 로 선언한다.

**이 저장소의 스펙 15편은 2026-08-30 에 그 규약으로 보정했다** — 괄호 안의 문서 이름 296곳을 링크로 바꿨고, 관계가 0건에서 **89건**이 됐다(고립 문서 0). 앞으로 쓰는 문서도 같은 규약을 따른다.

## 확인된 것

이 설정으로 실제로 확인한 것들이다(2026-08-29, 2026-08-30 갱신).

- MCP: `nerv` 서버 연결됨 · 도구 18종 조회됨
- 훅: 세션 시작이 NERV 에 세션을 만들고(`claude-code` · `ysm-mac-book` · 소유자 `admin@example.com`), 종료가 `complete` 로 닫는다
- 서브에이전트 훅(`SubagentStart`·`SubagentStop`)을 추가했다 — `/ingest/hooks/subagent` 가 토큰과 함께 202, 토큰 없이 401 을 준다(2026-08-29 갱신)
- 앞서 시험 삼아 만들었던 `jimin@example.com` 토큰은 **폐기했다**(폐기 후 401 을 확인했다)
- 시험으로 만든 세션 행은 지웠다 — 세션 화면은 비어 있는 상태에서 시작한다
- **바뀐 계약을 이 설정 그대로 확인했다**(2026-08-30 · 이 저장소의 토큰·헤더로): `nerv_bootstrap` → **`session_id` 없이** `nerv_question_create`(출처 `SUD-VISION` · 사유 `user-decision` · 선택지 2개) 성공 → `nerv_spec_get` 이 **키와 UUID 둘 다** 같은 문서를 준다. 확인용으로 만든 질문·세션은 지웠다
- 스킬·서브에이전트 사본이 원본과 **바이트 단위로 같다**(아래 재동기화 스크립트를 돌려 대조했다 — 바뀐 것이 없었다)
- **`nerv_spec_submit_review` 가 T1 문서를 그 자리에서 승인한다**(2026-08-31 · 스펙 15편 제출에서 13편이 `approved`, 규약 2편이 `in_review`). 위 "제출이 곧 승인이 되는 경우" 참조 — 이 저장소의 토큰·헤더로 확인한 동작이다

## 시험하는 법

이 디렉터리에서 `claude` 를 연다. 처음 열 때 `.mcp.json` 의 서버를 **신뢰할지 한 번 묻는다**(프로젝트 MCP 서버의 기본 동작이다).

```
/mcp                 서버 nerv 가 connected 인지
/nerv-next           다음 할 일을 받아 클레임한다(세션 부트스트랩부터 한다)
/nerv-spec           스펙을 읽고 초안을 쓴다
/nerv-question       판단이 막히면 사람에게 묻는다 — 받은 요청 화면으로 간다
```

웹에서 같이 보면 좋은 곳: **세션**(누가 무엇을 하고 있나) · **받은 요청**(에이전트의 질문) · **스펙**.

### 안 될 때

- `/mcp` 가 서버를 못 찾거나 `Missing environment variables` 라고 하면 → `.claude/settings.local.json` 의 `env` 가 안 읽힌 것이다. 그 자리에서 대신 등록한다:
  ```bash
  claude mcp add --scope local --transport http nerv http://localhost:8080/mcp \
    --header "Authorization: Bearer $(grep NERV_TOKEN .nerv/env | cut -d= -f2)" \
    --header "X-NERV-Project: sudoku"
  ```
  (셸에서 `claude mcp list` 를 그냥 돌리면 항상 이 경고가 뜬다 — 그 명령은 세션 설정을 읽지 않는다. 세션 안의 `/mcp` 가 기준이다.)
- 도구가 401 이면 토큰이 폐기됐거나 만료된 것이다. 새로 발급한다.
- 세션 화면에 아무것도 안 뜨면 훅이 안 나간 것이다. 훅은 **실패해도 세션을 멈추지 않는다**(텔레메트리라서). 손으로 확인:
  ```bash
  echo '{"session_id":"probe","source":"startup"}' \
    | /Volumes/project/private/nerv/codebase/plugin/bin/nerv-hook-forward session
  ```
- NERV 서버가 떠 있는지: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/v1/me`
