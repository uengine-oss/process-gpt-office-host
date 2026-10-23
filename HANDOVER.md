# 인수인계 — Process GPT 오피스 (이음오피스 편집기 연동)

이 문서는 이 작업을 이어받을 개발자를 위한 것이다. 무엇을 만들었고, 어디에 있고, 왜 그렇게 했고, 무엇이 남았는지를 적는다. 설계와 설정의 자세한 내용은 [README.md](README.md)에 있다. 제품 계약(외부에서 보이는 동작)은 process-gpt 저장소의 openspec에 있다(아래 1절).

작성: 2026-10-23

## 0. 한 줄 요약

Process GPT의 문서 편집기를 오픈소스 이음오피스(IeumOffice, Apache-2.0)의 편집기로 바꿨다.
- 업무에 첨부한 한글·워드·엑셀·PPT·PDF 문서가 원본 형식 그대로 열리고, 저장하면 원본 옆에 편집본이 따로 올라간다.
- 편집기의 AI 도우미는 사내 LLM으로 돌고, 문서가 열린 업무 단계의 맥락을 받는다.
- Process GPT 에이전트는 MCP 도구로 문서를 읽고 고친다. 사람이 열어 둔 문서는 그 사람이 보는 앞에서 고친다.

## 1. 어디에 무엇이 있나

| 무엇 | 저장소 · 브랜치 | 상태 |
|---|---|---|
| 백엔드(office-host) | [uengine-oss/process-gpt-office-host](https://github.com/uengine-oss/process-gpt-office-host) `main` | 공개. 포크는 `ieumoffice/` 서브모듈(고정 커밋) |
| process-gpt 등록 + openspec | [uengine-oss/process-gpt](https://github.com/uengine-oss/process-gpt/tree/feat/office-host-submodule) `feat/office-host-submodule` | `services/office-host` 서브모듈, README 목록, openspec 스펙 4개와 변경 기록. 머지 전 |
| 프론트엔드 | [uengine-oss/process-gpt-vue3](https://github.com/uengine-oss/process-gpt-vue3/tree/feat/office-editor-ieumoffice) `feat/office-editor-ieumoffice` | `origin/main` 기준. 머지 전 |
| 홈페이지 | [uengine-oss/uengine-new.github.io](https://github.com/uengine-oss/uengine-new.github.io/tree/feat/processgpt-office-editor) `feat/processgpt-office-editor` | Process GPT 기능 목록에 항목·영상 추가. 머지하면 공개 |
| 편집기 원본(포크) | [jinyoung/openoffice](https://github.com/jinyoung/openoffice) | **고치지 않는다.** upstream 개선을 그대로 받기 위해서다 |

openspec(process-gpt 저장소 `openspec/specs/`):
- `office-host_original-format-editing` — 원본 형식으로 열기·저장·편집본·미리보기·고지
- `office-host_work-context-assistant` — 업무 맥락을 받는 AI 도우미(사내 LLM)
- `office-host_agent-document-tools` — 에이전트용 문서 도구(MCP), 생성은 하지 않음
- `office-host_live-co-editing` — 사람이 열어 둔 문서를 에이전트가 실시간으로 고침
- 변경 기록: `openspec/changes/archive/2026-10-23-office-host-document-editor/`(제안·설계·작업)

## 2. 어떻게 맞물리나

```
업무 화면(FormWorkItem) ─ 첨부 카드(FileField) ─ 편집 대화 상자 ─┐
채팅(ChatRoomPage) ─ 문서 패널(ArtifactPanel) ──────────────────┴─ OfficeEditorFrame ─ iframe ─▶ office-host :5390
                                                                      ▲ postMessage                 ├ 편집기 화면 8개(포크 그대로)
                                                                      │ ready·saved·agent·error     ├ WebSocket = 편집기 탭 1개
deepagents(채팅 에이전트) ── MCP, 사용자 토큰 ─────────────────────────┼──────────────────────────▶ ├ /office/mcp 문서 도구·실시간 도구
                                                                      │                             ├ 저장 → Supabase Storage(edited-…)
                                                                      └──── context(업무 맥락) ────▶ └ AI → 사내 LLM(키는 서버에만)
```

- 핵심 기법은 **`electron` 모듈 하나만 바꿔 끼우기**다. 편집기 화면과 뒷단(main) 코드는 포크 그대로 쓰고, 그 사이의 IPC를 WebSocket으로 잇는다.
- 프론트는 `VITE_OFFICE_WEB_URL`이 있을 때만 새 편집기를 쓴다. 비우면 예전 뷰어가 그대로 돈다(되돌리기 쉬움).

## 3. 내린 결정과 이유

| 결정 | 이유 |
|---|---|
| 포크를 고치지 않고 `electron`만 심으로 바꾼다 | upstream(이음오피스·GenOffice) 개선을 그대로 받는다. 우리 코드는 연결층뿐이다 |
| 엑셀 사이드카(Rust)를 별도 서비스로 떼지 않는다 | 사이드카의 프로토콜·세션·충돌 복구를 편집기 뒷단이 관리한다. 떼면 포크를 고쳐야 하고 셀마다 네트워크 왕복이 생긴다. 늘릴 때는 office-host를 여러 개 띄우고 문서 id로 스티키 라우팅한다 |
| **문서 생성은 office-mcp, 이 서버는 읽기·편집만** | 이 서버의 도구는 사용자 토큰(`{{user_jwt}}`)으로 돈다. 백그라운드 업무 실행(todolist 폴링)에는 토큰이 없어서 deepagents가 이 서버를 아예 뺀다. 생성을 여기 맡기면 프로세스의 에이전트 단계에서 문서 생성이 조용히 빠진다. 그래서 만들던 도구(`office_create_document`)를 지웠다 |
| 저장은 원본 옆에 `edited-<원본 객체 이름>_<시각>` | 원본을 남긴다. 저장소 키는 ASCII여야 해서 화면 이름 대신 객체 이름을 쓴다. 편집본을 다시 고쳐도 `edited-edited-…`가 되지 않는다 |
| 화면 이름·AI 그림은 빌드 때 Process GPT 오피스로 | Apache-2.0 §6은 상표 사용권을 주지 않는다. 포크 파일은 그대로 두고 빌드에서 바꾼다. 고지는 `/office/licenses/`로 함께 낸다 |
| 사내 LLM 요청에 `reasoning_effort: low` | 사내 모델(gpt-oss 계열)이 출력 한도를 추론에 다 써서 답이 잘렸다 |

## 4. 로컬에서 돌리기

필요한 것: Node 22, Rust(엑셀 사이드카), 로컬 process-gpt(프론트 :5200, completion :8099, deepagents :8888, Supabase :54321).

```bash
git clone --recurse-submodules https://github.com/uengine-oss/process-gpt-office-host.git
cd process-gpt-office-host
(cd ieumoffice && npm ci && npm run studio -w @genoffice/hwp)
cargo build --release --manifest-path ieumoffice/apps/sheets/native/xlsx-engine/Cargo.toml
cd host && node build.mjs && node build-web.mjs && node build-licenses.mjs
# 환경 변수는 README 7절(값은 각 서비스의 .env 에서 가져온다 — 문서에 적지 않는다)
node dist/office-host.mjs        # :5390, /healthz
```

Process GPT 쪽:
- 프론트 `.env.local`에 `VITE_OFFICE_WEB_URL=http://localhost:5390`
- 에이전트 도구를 주려면 테넌트 MCP 설정에 `process-gpt-office`를 넣는다(README 7절의 JSON)

Docker: 이 저장소 루트에서 `docker build -t process-gpt-office-host .`(서브모듈을 받은 뒤). 2026-10-23에 푸시한 상태로 빌드·기동(`/healthz`·편집기 화면·고지 200)을 확인했다.

## 5. 확인한 것과 확인하는 방법

| 무엇 | 어떻게 확인했나 |
|---|---|
| 편집기 8개 | `:5390/office/<편집기>/?src=…`로 열기 |
| 원본 충실도 | docx·hwpx를 열고 저장한 뒤 패키지 안 바뀐 부품 비교(docx 31개 중 2개, hwpx 3개 항목만 바뀜) |
| 업무 맥락 | 기안 작성 단계에서 "팀장 요청대로 다듬어 줘"만으로 추진 배경 공문체화·빈 항목 채움 |
| 실시간 공동 편집 | 업무 화면에서 워드 초안을 열어 둔 채, 채팅으로 deepagents에게 채워 달라고 함 → 18초 안에 빈칸 3곳을 채우고 저장, 첨부가 편집본으로 |
| 채팅 문서 패널 | 채팅에서 에이전트가 `office_apply_ops`로 고친 문서가 옆 패널 편집기로 열리고, 이어서 실시간으로 채움 |
| MCP 도구 | MCP 클라이언트로 도구 목록·읽기·연산 편집(배열과 JSON 문자열 둘 다)·실시간 도구 |

시연 영상(6분 32초, 18장면, 실제 화면)은 [YouTube](https://youtu.be/rItCQPQFPis)와 홈페이지 브랜치의 `media/processgpt/processgpt-office-demo.mp4`(한국어 자막 VTT 포함)에 있다. 영상을 만드는 녹화·검증 스크립트(Playwright 정지화면 + ElevenLabs 나레이션)는 로컬 개발 데이터와 계정에 묶여 있어 저장소에 넣지 않았다. 필요하면 정리해서 openspec 스펙 폴더의 `e2e/`로 옮기는 것이 이 저장소들의 규칙에 맞다.

## 6. 남은 일 (우선순위 순)

1. **세 브랜치 머지.** process-gpt(서브모듈·openspec), process-gpt-vue3, 홈페이지. 프론트 브랜치는 `origin/main` 위에 다시 올린 것이라 화면에서 한 번 더 돌려 볼 것.
2. **배포 설정.** office-host 이미지 배포, Ingress의 WebSocket과 문서 id 스티키 라우팅, `VITE_OFFICE_WEB_URL`, 테넌트 MCP 등록.
3. **인증 강화.** 지금은 Supabase HS256 비밀키 검증뿐이다. 비대칭 키(JWKS)를 쓰면 그 검증을 붙인다. 토큰이 iframe 주소 쿼리에 실리므로 짧은 일회용 토큰으로 바꾸는 편이 좋다.
4. **백그라운드 편집.** 에이전트 단계(백그라운드)에서도 문서를 고치게 하려면 서비스 토큰과 테넌트·담당자 확인을 붙인 별도 경로가 필요하다(지금은 일부러 막혀 있다).
5. **deepagents의 도구 결과 형식.** 도구 결과 메시지를 통째로 문자열로 바꿔 보내서, 채팅 화면이 `content=[…]` 꼴을 따로 읽는다(process-gpt-vue3 `main`의 `shared/toolOutput`이 이미 읽는다). deepagents 쪽에서 블록의 `text`를 보내게 고치면 다른 소비자도 깔끔해진다(재시작 필요).
6. **데스크톱 전용 기능.** PDF 내보내기·인쇄(숨은 창), "다른 이름으로 저장" 대화 상자, 맞춤법·Zotero·Google 드라이브. 헤드리스 Chromium으로 대체하거나 끈다.
7. **글꼴과 정리.** 한글 글꼴을 이미지에 넣기(워드의 Calibri는 지금 대체 글꼴), 끊긴 세션 폴더 정리, 폼 제출 때 "지금 저장" 메시지.
8. **포크 갱신.** upstream이 바뀌면 `ieumoffice/` 서브모듈 커밋을 올리고 빌드해 본다. 빌드가 포크의 두 곳에 기대고 있다. 바뀌면 빌드가 멈추며 알려 준다.
   - `packages/cli/src/resources.ts`의 `repoRoot()`
   - `packages/i18n/src/product.ts`의 제품 이름

## 7. 모르면 걸리는 것

- **PDF로 내보내기는 서버에서 안 된다.** 포크의 CLI는 PDF 내보내기(와 docx→html, html→docx)를 데스크톱 앱의 숨은 창으로 한다. 서버에는 그 창이 없어서 그냥 멈췄다. 지금 `office_convert`는 이 프로세스에서 되는 변환만 받고 나머지는 바로 거절한다(남은 일 6).
- **블록 번호는 밀린다.** 실시간 도구로 위에서부터 블록 번호로 바꾸면, 앞의 변경이 뒤 번호를 민다. 실제로 에이전트가 제목을 덮어썼다. 자리 표시를 채울 때는 `office_live_replace`의 `match_text`를 쓴다.
- **`ops`가 문자열로 온다.** 타입이 없는 스키마에서는 에이전트가 연산 배열을 JSON 문자열로 보냈다. 지금은 스키마에 배열 타입을 주고 문자열도 받는다.
- **심의 모르는 멤버.** 서버용 심의 WebContents는 모르는 멤버를 아무것도 안 하는 함수로 돌려준다. host가 쓰는 필드는 생성자에서 `null`로 먼저 선언해야 `??=`가 먹는다.
- **esbuild 외부화가 alias보다 먼저 잡는다.** `electron`·`electron-updater`·`@ieum/…`은 외부화 플러그인 안에서 처리한다.
- **API로 시작한 인스턴스는 담당자가 없다.** 첫 제출에 `role_mappings`를 넣어야 폼이 읽기 전용이 되지 않는다(시연·E2E에서).
- **채팅은 방이 있어야 한다.** `/chat`은 방을 골라야 입력창이 생긴다. 새 방의 기본 오케스트레이션은 deepagents다.
- **로컬 Docker(colima)는 `host.docker.internal`을 풀지 않는다.** `--add-host=host.docker.internal:host-gateway`를 붙인다.
- **라이선스.** 포크 코드는 계속 Apache-2.0이다. `LICENSE`·`NOTICE`·제3자 고지와 한글과컴퓨터 공개 문서 문구를 함께 내야 한다(README 6절, `NOTICE.md`).
