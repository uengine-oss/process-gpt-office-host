# 변경 기록 (Changelog)

이 저장소(process-gpt-office-host)의 눈에 띄는 변경을 적습니다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따릅니다.

## [Unreleased]

### 고침

- **텍스트 편집기에서 캐럿이 있는 줄의 선택이 보이고, 같은 내용을 다시 저장해도 답한다** (2026-11-27, Process GPT Lite) — 마크다운 앱의 텍스트 편집기(.txt · .json)는 캐럿이 있는 줄을 불투명한 색(`--hover`)으로 칠하는데, 선택은 글 뒤에 그려서 Shift+화살표 · Shift+End 로 그 줄을 골라도 보이지 않았습니다. 페이지(렌더러 shim)가 그 줄의 색을 비치게 합니다. 포크에 보낼 수정은 `patches/ieumoffice-plain-text-selection.patch`(apps/markdown/src/renderer/source/PlainTextEditor.tsx `.cm-activeLine`)입니다. 또 이 열기에서 한 번 올린 뒤 문서가 같은 내용으로 다시 써지면(고쳤다가 되돌린 뒤 저장) 올릴 것은 없지만 `office:saved` 를 `unchanged: true` 와 그 주소로 보내, 저장을 누른 쪽이 답을 기다리다 멈추지 않습니다. 아직 올린 것이 없으면 아무것도 보내지 않고, 올리기는 한 번에 하나씩이라 올리는 중에 온 저장은 그 올리기가 끝난 뒤에 봅니다. 작업 폴더의 다른 파일이 바뀐 것은 말하지 않습니다. (초 단위로만 시각을 남기는 파일 시스템에서는 같은 초 안의 다시 쓰기를 알아채지 못해 답이 없습니다.) 시험: `node --test host/documents.test.mjs`.
- **편집기 연결이 조용히 끊기지 않고, 끊기면 요청이 곧바로 실패한다** (2026-11-27 운영, Process GPT Lite 스펙 `folder-edit-save` 「채팅의 문서」) — 운영 앞단의 Cloudflare 는 아무것도 오가지 않는 웹소켓을 100초 남짓 지나면 끊습니다(운영 주소에서 125초에 1006). 그 뒤 페이지(렌더러 shim)는 닫힌 소켓에 요청을 계속 보냈고, 브라우저는 그 프레임을 말없이 버려 편집기의 저장이 답을 영영 기다렸습니다(마크다운 · TXT 편집기 상태 줄 「저장 중…」). 이제 페이지가 30초마다 `{t:'ping'}` 을 보내고(호스트는 `pong` 으로 답함) 닫힌 연결로 가는 요청은 바로 거절해, 편집기는 「저장 실패」를 보입니다(`host/ipc-link.mjs`). `.txt` 편집본은 `text/plain` 으로 올리고, 올리기에 실패한 저장은 같은 내용으로 다시 저장해도 다시 올립니다. 시험: `node --test host/ipc-link.test.mjs`.
- **워드 칸의 세로 정렬이 화면에 보이고, 서식 편집 뒤 문서가 보여 주는 것을 결과에 싣는다** (2026-11-25 12:57 운영, pgpt-pro 스펙 `office-live-edit`) — 행 높이 설정 없이 문단 아래 간격(문서 기본값)만으로 높아진 칸은 `setTableCellFormat`의 `vAlign`이 적용돼도 글이 움직이지 않았습니다(Word도 동일하게 표시합니다). 이제 `office_live_apply_ops`가 세로 정렬을 바꾼 칸의 문단 위아래 간격을 정렬에 맞게 조정해 칸 높이를 유지하면서 글을 해당 위치에 배치하며(`aligned`), 서식 연산마다 문서에 현재 표시되는 상태(칸의 `vAlign`·`fill`·`borders`와 글 위아래 공간, 문단의 값과 화면상 정렬)를 결과의 `check`로 반환합니다. 워드의 선택 영역은 표에서 선택한 칸을 행별로 포함하는 `textRanges`도 알려 줍니다. 부모 모드에서는 표 칸 안의 문단에 남아 있던 노란 「AI 변경」 표시를 숨깁니다(포크 수정은 `patches/ieumoffice-clear-nested-ai-marks.patch`). 시험: `node --test host/page-live.test.mjs`.
