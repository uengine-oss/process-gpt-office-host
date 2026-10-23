# process-gpt-office-host — 이음오피스 편집기를 Process GPT에 붙이는 문서 편집 백엔드

이음오피스(IeumOffice, jinyoung/openoffice)의 편집기 8개를 **포크의 소스를 한 줄도 고치지 않고** 브라우저에서 띄우는 서비스(office-host)와, 이것을 Process GPT 화면과 에이전트에 붙인 변경을 적는다. AI는 사내 LLM 서버의 `frentis-ai-model`을 쓴다.

Process GPT 저장소에서는 `services/office-host` 서브모듈이다. 포크는 이 저장소의 `ieumoffice/` 서브모듈로 들어 있다(시험한 커밋에 고정). 포크를 옆 폴더(`../ieumoffice`)에 따로 받아 두어도 되고, `IEUM_FORK_ROOT`로 위치를 줄 수도 있다(`host/fork-root.mjs`).

## 1. 방식

- 이음오피스의 편집기 화면(React + Vite)은 Electron 없이 브라우저에서 그대로 돈다. Electron에 묶인 것은 preload 다리와 뒷단(main) 코드뿐이다.
- 이 둘을 바꾸지 않고, 둘 사이의 `electron` 모듈만 바꿔 끼운다.
  - 브라우저 쪽에서는 preload의 `ipcRenderer`가 WebSocket으로 간다.
  - 서버 쪽에서는 뒷단 코드를 Node에서 돌리고, `ipcMain`을 WebSocket으로 받는다.
  - 데스크톱 앱의 사용자 정의 스킴(`genoffice-*://`)은 HTTP 경로 `/office/__proto/...`로 내준다.
- 그래서 upstream(GenOffice·이음오피스)의 개선을 그대로 받을 수 있다.
- Process GPT에는 iframe으로 넣는다. Process GPT는 Vue 3.2, 편집기는 React다. 둘은 `postMessage`로 주고받는다.

```
Process GPT (Vue 3)                                   office-host (Node 22, 컨테이너 하나, :5390)
 ArtifactPanel(hwpx·docx 패널)                         GET  /office/<편집기>/     빌드된 화면 + preload
 FileField → HwpxEditorDialog (최대화·전체 화면)        WS   /office/__ipc         연결 1개 = 편집기 탭 1개
   └─ <OfficeEditorFrame> ── iframe ──────────────▶    GET  /office/__proto/…     문서 바이트·그림·글꼴
        ──▶ context(업무 단계·지시·이전 입력)              GET  /office/licenses/     오픈소스 고지
        ◀── ready · saved · agent · error                 POST /office/mcp          에이전트 도구(MCP)
                                                            │
 deepagents (채팅) ── MCP, 사용자 토큰 ────────────────▶    ├─ apps/*/src/main  (원본 그대로, electron → 심)
 Supabase Storage ◀── edited-<이름>_<시각>.<확장자> ─────── ├─ xlsx-sidecar (Rust, 자식 프로세스, stdio)
                  ──▶ ?src= 문서 내려받기 ──────────────── └─ ai:* → 사내 LLM (frentis-ai-model, 키는 서버에만)
```

## 2. 에이전트와의 연결

### 2.1 편집기 도우미가 업무 맥락을 안다

업무 화면(`FormWorkItem`)은 문서를 연 단계의 이름·설명·지시와 이전 단계 입력을 편집기로 넘긴다(`OfficeEditorFrame` → `context` 메시지). host는 그 탭의 AI 요청 시스템 프롬프트 끝에 이것을 붙인다(`host/work-context.mjs`). 그래서 "팀장 요청대로 다듬어 줘"만으로 무엇을 고칠지 안다. 맥락의 문장이 사용자 요청과 부딪히면 사용자 요청을 따르게 적어 두었다.

### 2.2 문서 생성은 office-mcp, 편집은 이 서버

**새 문서를 만드는 일은 기존 office-mcp(스킬 + `store_and_render_hwpx` 경로)가 맡는다. 이 서버의 MCP 도구는 이미 있는 문서를 읽고 고치기만 한다.**

이렇게 나눈 이유는 배경 실행이다.
- 이 서버의 도구는 사용자 토큰으로 돈다. 테넌트 MCP 설정의 헤더가 `Authorization: Bearer {{user_jwt}}`다.
- deepagents는 토큰이 없는 요청에서 `{{user_jwt}}`를 쓰는 서버를 아예 뺀다(`core/llm/mcp.py`의 `resolve_user_placeholders`).
- 업무 단계를 백그라운드로 처리할 때(todolist 폴링)는 사용자 토큰이 없다. 그래서 그때는 이 도구들이 보이지 않는다.
- 문서 생성을 이 서버에 맡기면, 프로세스의 에이전트 단계에서 문서 생성이 조용히 빠진다. office-mcp는 서버 키로 올리므로 백그라운드에서도 돈다.

사람이 있는 곳(채팅, 열린 편집기)에서는 이 서버의 도구로 고친다.

| 도구 | 하는 일 |
|---|---|
| `office_guide` | 형식별 편집 연산(op) 설명서 |
| `office_read_document` | 저장소의 문서를 읽는다(docx·xlsx·pptx·pdf·hwp·hwpx) |
| `office_apply_ops` | 문서를 연산으로 고쳐 원본 옆에 `edited-…`로 올린다(docx·xlsx·pptx) |
| `office_convert` | 다른 형식으로 바꿔 올린다(예: docx→pdf) |
| `office_live_documents` | 이 사용자가 지금 편집기에 열어 둔 문서 |
| `office_live_read` | 열린 문서의 지금 내용(블록 번호가 붙은 본문, 엑셀은 셀) |
| `office_live_write` / `office_live_replace` | 열린 워드 문서에 넣는다 / 바꾼다. `match_text`로 "(작성 예정)" 같은 자리를 글로 찾아 바꾼다 |
| `office_live_apply_ops` | 열린 문서에 편집 연산 |
| `office_live_save` | 열린 문서를 저장한다. 편집본이 올라가고 업무 화면의 첨부도 바뀐다 |

- 고친 문서는 원본을 두고 옆에 `edited-<원본 객체 이름>_<시각>.<확장자>`로 올린다. 저장소 키는 ASCII여야 해서 원본 객체 이름을 쓴다.
- 결과에 `editor_url`(편집기 주소)을 준다. docx 결과에는 채팅 문서 패널이 읽는 `html_url`·`content_type`도 준다.

### 2.3 에이전트가 쓰는 것을 사람이 지켜본다

- 편집기에는 이미 MCP 다리(`apps/docs|sheets/src/renderer/mcp-bridge.ts`)가 있다. 데스크톱 셸이 `<editor>:mcp-command`를 보내면, 열린 편집기가 내장 AI와 같은 실행기로 명령을 처리하고 `<editor>:mcp-result`로 답한다.
- host가 셸 역할을 한다(`host/live.mjs`). 연결 하나가 세션 하나다. 사용자 토큰의 `sub`가 같은 세션만 그 사용자의 에이전트에게 보인다.
- 에이전트가 쓰기 시작하면 host가 `office:agent`를 보낸다. Process GPT의 `OfficeEditorFrame`은 이것을 "에이전트가 내용을 바꾸는 중 · …" 알림으로 띄운다.
- 저장하면 첨부가 편집본으로 바뀐다(기존 `saved` 흐름).

`ops`는 연산 객체의 배열이다. 에이전트가 배열을 JSON 문자열로 보내는 일이 있어서 둘 다 받는다(타입 없는 스키마에서는 실제로 문자열로 왔다).

여러 곳을 블록 번호로 바꾸면 앞의 변경이 뒤의 번호를 민다. 실제로 이 때문에 에이전트가 제목을 덮어쓴 일이 있어서, `match_text`를 넣고 도구 설명에 "뒤에서부터 바꾸거나 다시 읽기"를 적었다.

## 3. 확인한 것 (2026-10-23)

| 항목 | 결과 |
|---|---|
| 편집기 8개 | 워드·엑셀·PPT·PDF·한글·마크다운·HTML·마인드맵이 모두 `:5390/office/<편집기>/` 한 출처에서 오류 없이 열림 |
| 사내 LLM | `frentis-ai-model`이 스트리밍 도구 호출을 표준 형식으로 돌려줌. gpt-oss 계열이라 `reasoning_effort: low`를 붙여야 답이 잘리지 않음 |
| 업무 맥락 | 기안 작성 단계에서 "팀장 요청대로 다듬어 줘"로 한글 기안을 다듬음(시연 영상 5~7장면) |
| 실제 에이전트 | process-gpt deepagents(:8888, 채팅)가 테넌트 MCP로 이 서버를 불러, 업무 화면에 열린 워드 초안의 빈칸 3곳을 채우고 저장. 18초. 편집기에 문단이 차례로 들어오고 알림이 뜸. 첨부가 편집본으로 바뀜 |
| 채팅 문서 패널 | 채팅에서 에이전트가 `office_apply_ops`로 고친 워드 문서가 옆 패널의 편집기로 열리고, 다음 요청에서 그 문서의 "(작성 예정)" 세 곳을 실시간으로 채워 저장(실제 deepagents) |
| 배경 실행 | 토큰 없는 요청에서는 deepagents가 이 서버를 빼는 것을 코드로 확인(2.2) |
| Process GPT 컴포넌트 | 실제 화면에서 FileField → 편집 → 최대화 → 저장 → 편집본 카드, 결재자 미리보기(저장해도 업로드 안 함) |
| 저장 충실도 | docx: 31개 부품 중 본문·수정 시각 2개만 바뀜. hwpx: 본문·머리·목록 3개 항목만 바뀜 |
| 한글 단축키 | rhwp iframe 안에서 누른 ⌘S가 뒷단 저장 흐름으로 이어져 `edited-…hwpx` 업로드 |
| 경로 가두기 | 페이지가 `/etc/hosts` 열기, `/tmp/../etc/…` 저장을 요청하면 거절. 정상 호출은 통과 |
| 로컬 Supabase | 사용자 토큰 + anon 키로 실제 업로드(서비스 키 없이) |
| Docker 이미지 | 빌드·실행. 컨테이너에서 리눅스용 xlsx 사이드카로 엑셀, 서버 세션으로 PPT, 한글·워드가 저장소 URL로 열림. 사내 LLM 서버에 닿음 |

## 4. 파일

| 파일 | 하는 일 |
|---|---|
| `host/office-host.mjs` | 진입점. HTTP(화면·`__proto`·`/office/mcp`·`/office/licenses/`·`/healthz`)와 WebSocket(`__ipc`). 연결 때 토큰 확인 → 작업 폴더 → 편집기 뷰 → 실시간 세션 등록. 호출마다 경로 검사, AI 설정 바꿔 끼우기, 업무 맥락 붙이기 |
| `host/editors.mjs` | 편집기 8개를 껍데기 앱(`apps/shell/src/main`)과 같은 순서로 엮는다. 확장자 → 편집기 표 |
| `host/documents.mjs` | 연결마다 작업 폴더. `?src=` 내려받기(허용된 출처만), 저장 감지 → Supabase 업로드 → `office:saved`. 경로 가두기 |
| `host/auth.mjs` | Supabase 토큰(HS256) 확인 |
| `host/ai-settings.mjs` | 사내 LLM 설정. 페이지에는 키를 가린 설정만, 요청의 `settings`는 서버 설정으로 바꿔 끼운다. `reasoning_effort` |
| `host/work-context.mjs` | 업무 맥락 정리·제한·시스템 프롬프트에 붙이기 |
| `host/worker-mcp.mjs` | 에이전트 도구(MCP, Streamable HTTP, 상태 없음). 포크의 CLI 명령층(`packages/cli`의 `runJson`)을 이 프로세스에서 그대로 쓴다 |
| `host/live.mjs` | 실시간 세션: 열린 편집기에 명령 보내고 답 받기, 에이전트 알림 |
| `host/brand.mjs` | 빌드 때 제품 이름·AI 그림·페이지 제목을 Process GPT 오피스로 바꾼다(포크 파일은 그대로) |
| `host/static.mjs` | 빌드된 화면을 `/office/<편집기>/`에서 내주고 preload를 끼운다. 고지 페이지 |
| `host/fork-root.mjs` | 포크 위치 찾기(`IEUM_FORK_ROOT` → 서브모듈 `ieumoffice/` → 옆의 `../ieumoffice` → 상위 폴더, 의존성이 설치된 것만). 포크 소스는 `@ieum/…`로 가져온다 |
| `host/electron-main-shim.mjs` / `electron-renderer-shim.mjs` | 서버용·브라우저용 `electron`. 브라우저 쪽은 부모 알림, 업무 맥락 받기, 단축키 전달도 한다 |
| `host/wire.mjs` | 두 심의 전송 형식(바이너리 표시가 붙은 JSON) |
| `host/build.mjs` / `build-web.mjs` / `build-licenses.mjs` | host·preload 번들 / 편집기 화면 정적 빌드 / 고지 모음과 고지 페이지 |
| `NOTICE.md` | 오픈소스 고지(무엇을 바꿨나, 함께 내는 고지, 한글 공개 문서 조건, 상표, 라이선스의 관계) |
| `Dockerfile` (+ `.dockerignore`) | Rust 사이드카 → 포크 빌드 → 실행 이미지. 이 저장소의 루트에서 빌드한다 |
| `ieumoffice/` | 포크(jinyoung/openoffice) 서브모듈 |
| `vite.web.config.mjs` | 개발용(HMR). 편집기 하나를 띄우고 `__ipc`·`__proto`를 host로 넘긴다 |

Process GPT 쪽(`process-gpt-vue3`)은 다음과 같다. 사용자가 작업 중인 `ChatRoomPage.vue`와 `vite.config.ts`는 건드리지 않았다.

| 파일 | 변경 |
|---|---|
| `src/utils/officeEditor.js` (새 파일) | `VITE_OFFICE_WEB_URL` 읽기, 확장자 → 편집기, 저장소 키 → 공개 URL, iframe 주소(+Supabase 토큰) |
| `src/components/OfficeEditorFrame.vue` (새 파일) | iframe과 메시지 처리. 최대화·전체 화면·닫기 단추, 업무 맥락 보내기, 저장·에이전트·오류 알림 |
| `src/components/ArtifactPanel.vue` | `hwpx`·`docx` 패널에 원본 `fileUrl`이 있으면 프레임으로 연다. 저장되면 패널의 `fileUrl`을 편집본으로 바꾸고 `office-saved` 액션을 낸다 |
| `src/components/ui/field/HwpxEditorDialog.vue` | 열 수 있는 문서면 프레임을 띄운다. 최대화하면 대화 상자가 화면 가득. 저장 → `updated{fileUrl, htmlUrl:''}` |
| `src/components/ui/field/FileField.vue` | 편집기가 켜져 있으면 hwpx 외 docx·xlsx·pptx·pdf·hwp·md·html 첨부도 다운로드·미리보기·편집 카드로 보인다. 편집본이면 "편집본 · 다운로드" |
| `src/components/apps/todolist/FormWorkItem.vue` | 업무 맥락(단계·설명·지시·이전 단계 입력)을 `officeWorkContext`로 내려 준다 |
| `.env.example` | `VITE_OFFICE_WEB_URL=` 추가. 비우면 예전 뷰어 그대로 |

## 5. 사이드카를 마이크로서비스로 떼야 하나?

**서버에서 제공은 해야 한다. 다만 사이드카마다 서비스로 쪼개지 않고, office-host 한 서비스 안의 자식 프로세스로 둔다.**

서버 상태가 필요한 편집기는 둘뿐이다.
- **엑셀**: Rust 엔진이 열린 통합 문서를 쥔다.
- **PPT**: 문서 모델과 실행 취소가 뒷단 세션에 있다.

나머지는 엔진이 브라우저에서 돈다.

떼지 않는 이유:
1. 사이드카의 stdio 프로토콜·세션·저장 순서·충돌 복구를 `sheets-main`이 관리한다. 떼어 내려면 포크를 고쳐야 한다.
2. 셀 편집마다 엔진을 왕복하므로 네트워크 홉만큼 느려진다.
3. 상태가 탭 단위라 어차피 같은 문서는 같은 프로세스로 가야 한다. 실시간 세션(2.3)도 그 프로세스 안에 있다.

늘리는 방법과 나누는 기준:
- office-host를 여러 개 띄우고, WebSocket을 문서 id 기준 스티키 라우팅으로 보낸다. 실시간 도구 호출도 같은 사용자의 세션이 있는 인스턴스로 가야 한다.
- 나눈다면 대화형 편집과 배치 작업(문서 도구, 변환, PDF 내보내기)으로 나눈다. 같은 이미지로 띄울 수 있다.

## 6. 라이선스와 이름

- 포크(IeumOffice·GenOffice)는 Apache-2.0이다. 함께 배포할 수 있다. 조건은 고지를 함께 내는 것이다(§4).
  - `LICENSE`·`NOTICE`·`LICENSE-UNICODE.txt`·`THIRD-PARTY-NOTICES.txt`와 `NOTICE.md`를 `/office/licenses/`와 이미지의 `/app/licenses/`에 둔다.
  - 배포 의존성은 모두 허용 목록 안이다. 카피레프트는 없다. rhwp는 MIT, xlsx 엔진은 Apache-2.0, 글꼴은 OFL이다.
- Apache-2.0 §6은 상표 사용권을 주지 않는다. 그래서 화면의 이름과 AI 그림을 빌드 때 Process GPT 오피스로 바꾼다(`host/brand.mjs`). 포크 파일은 그대로다. 문서 메타데이터(ODT `meta:generator`)는 바꾸지 않는다.
- 한글 편집기는 한글과컴퓨터의 공개 문서 조건에 따라 "본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다."를 밝힌다.
- 포크에서 온 코드는 계속 Apache-2.0이다. Process GPT의 Commons Clause는 UENGINE 코드에만 걸린다.

## 7. 설정

| 변수 | 뜻 | 기본값 |
|---|---|---|
| `CUSTOM_LLM_BASE_URL` (또는 `LLM_PROXY_URL`) | 사내 LLM 주소 (OpenAI 호환) | — 예: `http://<사내 LLM 서버>/v1` |
| `CUSTOM_LLM_API_KEY` (또는 `LLM_PROXY_API_KEY`) | 사내 LLM 키 | — |
| `CUSTOM_LLM_MODEL` (또는 `LLM_MODEL`) / `CUSTOM_LLM_NAME` | 모델 / 화면에 보일 이름 | `frentis-ai-model` / `사내 LLM` |
| `CUSTOM_LLM_REASONING_EFFORT` | 추론 모델에 붙일 `reasoning_effort` | `low` |
| `SUPABASE_URL` / `SUPABASE_PUBLIC_URL` | 업로드할 Supabase(서버에서 닿는 주소) / 브라우저가 보는 주소 | — / `SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` (또는 `SUPABASE_KEY`) | 서비스 키로 업로드 | — |
| `SUPABASE_ANON_KEY` | 서비스 키가 없을 때, 로그인 사용자의 토큰과 이 키로 업로드(사용자 권한 그대로) | — (둘 다 없으면 업로드하지 않음) |
| `SUPABASE_JWT_SECRET` | 연결·MCP 토큰(HS256) 확인. 없으면 인증 없음(로컬 시험 전용) | — |
| `IEUM_ALLOWED_SOURCES` | `src`로 받을 수 있는 출처(쉼표로 구분) | `SUPABASE_URL`의 출처만 |
| `IEUM_PUBLIC_URL` | 도구 결과의 `editor_url`에 쓸 이 서버의 주소 | `http://localhost:5390` |
| `IEUM_NEW_DOC_BUCKET` | 저장소 밖 문서를 고치거나 바꿀 때 올릴 버킷 | `files` |
| `IEUM_BRAND_NAME` / `IEUM_BRAND_NAME_KO` | 화면에 보일 제품 이름(빌드 때) | `Process GPT Office` / `Process GPT 오피스` |
| `IEUM_FORK_ROOT` | 포크 위치 | 옆의 `ieumoffice` → 상위 폴더 |
| `XLSX_SIDECAR_PATH` | Rust 사이드카 실행 파일 | 이미지 안 `/usr/local/bin/xlsx-sidecar` |
| `IEUM_HOST_DATA` / `IEUM_HOST_PORT` / `IEUM_LANG` | 작업 폴더·설정 위치 / 포트 / 화면 언어 | `/data` / `5390` / `ko` |
| `IEUM_WORKSPACE` | 로컬 시험용 샘플 폴더(`?src=sample.docx`). 운영에서는 비운다 | — |
| Process GPT `VITE_OFFICE_WEB_URL` | office-host 주소. `window._env_`로도 줄 수 있다 | — (비우면 예전 뷰어) |

에이전트에게 도구를 주려면 테넌트 MCP 설정(`tenants.mcp.mcpServers`)에 넣는다.

```json
"process-gpt-office": {
  "url": "http://<office-host>/office/mcp",
  "type": "streamable-http",
  "enabled": true,
  "headers": { "Authorization": "Bearer {{user_jwt}}" }
}
```

## 8. 남은 일

1. **채팅 문서 패널은 프론트 쪽에서 풀었다(2026-10-23).**
   - deepagents는 MCP 도구 결과를 `content=[{'type': 'text', …}]` 꼴의 문자열로 채팅에 보낸다. 채팅 화면의 도구 결과 해석이 이 꼴도 읽게 고쳤다(process-gpt-vue3).
   - 그래서 에이전트가 고친 워드 문서(`html_url`이 붙은 결과)가 채팅 옆 문서 패널의 편집기로 열리고, 이어서 실시간 도구로 그 문서를 채우는 모습을 채팅 화면 안에서 본다.
   - 패널에서 저장하면 메시지의 문서 카드도 편집본으로 바뀐다(`office-saved`).
   - 근본 원인은 deepagents가 도구 결과 메시지를 통째로 문자열로 바꾸는 데 있다. deepagents 쪽에서 블록의 `text`를 보내게 고치면 다른 소비자도 깔끔해진다. 공유 서비스라 재시작이 필요해 손대지 않았다.
2. **에이전트 단계(백그라운드)의 문서 편집.** 지금 도구는 사용자 토큰이 있어야 해서 백그라운드 업무 실행에는 붙지 않는다(2.2). 백그라운드에서도 고치게 하려면 서비스 토큰과 테넌트·담당자 확인을 붙인 별도 경로가 필요하다.
3. **인증.** 지금은 HS256 비밀키 검증만 한다. Supabase가 비대칭 키(JWKS)를 쓰면 그쪽 검증을 붙인다. 토큰이 iframe 주소의 쿼리에 실리므로, 운영에서는 짧은 일회용 토큰으로 바꾸는 편이 좋다.
4. **저장소.** 지금은 공개 URL로 돌려준다. 비공개 버킷이면 서명 URL을 쓴다.
5. **데스크톱 전용 기능.** 숨은 창으로 하는 PDF 내보내기·인쇄와 altChunk 변환은 헤드리스 Chromium으로 대체한다. 맞춤법·Zotero·Google 드라이브는 끈다. "다른 이름으로 저장" 대화 상자는 지금 취소로 끝난다.
6. **부모 → 편집기 명령.** 폼 제출 때 "지금 저장"을 보내는 메시지는 아직 없다. 사용자가 편집기 안에서 저장해야 한다.
7. **글꼴과 세션.**
   - 한글 글꼴(Noto Sans KR, 나눔)을 이미지에 묶는다. 워드 기본 글꼴(Calibri)은 대체 글꼴로 보인다.
   - 끊긴 세션 폴더는 30분 뒤 지운다. 자동 복구 사본을 둘 곳을 정한다.
   - 스티키 라우팅 Ingress 설정을 만든다.

## 9. 돌려 보기

```bash
# 포크 받기 (한 번)
git submodule update --init
(cd ieumoffice && npm ci && npm run studio -w @genoffice/hwp)    # 의존성, 한글 편집기(rhwp-studio)
cargo build --release --manifest-path ieumoffice/apps/sheets/native/xlsx-engine/Cargo.toml   # 엑셀 사이드카

# 로컬
cd host
node build.mjs && node build-web.mjs && node build-licenses.mjs   # host·preload 번들, 편집기 화면 8개, 고지
CUSTOM_LLM_BASE_URL=… CUSTOM_LLM_API_KEY=… \
SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_JWT_SECRET=… IEUM_ALLOWED_SOURCES=http://127.0.0.1:54321 \
XLSX_SIDECAR_PATH=… node dist/office-host.mjs
# → http://localhost:5390/office/docs/?src=<저장소 URL>&token=<사용자 토큰>   (healthz: /healthz)

# Process GPT: services/frontend/.env.local 에 VITE_OFFICE_WEB_URL=http://localhost:5390

# Docker (이 저장소의 루트에서, 서브모듈을 받은 뒤)
docker build -t process-gpt-office-host .
docker run -p 5390:5390 -e CUSTOM_LLM_BASE_URL=… -e CUSTOM_LLM_API_KEY=… -e SUPABASE_URL=… \
  -e SUPABASE_SERVICE_ROLE_KEY=… -e SUPABASE_JWT_SECRET=… -e IEUM_ALLOWED_SOURCES=… process-gpt-office-host
# 저장소가 같은 PC에 있으면 --add-host=host.docker.internal:host-gateway 를 붙인다
```

이미지 크기(약 2.5GB)는 포크의 node_modules 전체를 담아서다. host 번들에 npm 패키지까지 넣으면(네이티브·wasm 패키지만 외부로) 크게 줄일 수 있다.
