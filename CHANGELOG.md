# 변경 기록 (Changelog)

이 저장소(process-gpt-office-host)의 눈에 띄는 변경을 적습니다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따릅니다.

## [Unreleased]

### 고침

- **워드 칸의 세로 정렬이 화면에 보이고, 서식 편집 뒤 문서가 보여 주는 것을 결과에 싣는다** (2026-11-25 12:57 운영, pgpt-pro 스펙 `office-live-edit`) — 행 높이 설정 없이 문단 아래 간격(문서 기본값)만으로 높아진 칸은 `setTableCellFormat`의 `vAlign`이 적용돼도 글이 움직이지 않았습니다(Word도 동일하게 표시합니다). 이제 `office_live_apply_ops`가 세로 정렬을 바꾼 칸의 문단 위아래 간격을 정렬에 맞게 조정해 칸 높이를 유지하면서 글을 해당 위치에 배치하며(`aligned`), 서식 연산마다 문서에 현재 표시되는 상태(칸의 `vAlign`·`fill`·`borders`와 글 위아래 공간, 문단의 값과 화면상 정렬)를 결과의 `check`로 반환합니다. 워드의 선택 영역은 표에서 선택한 칸을 행별로 포함하는 `textRanges`도 알려 줍니다. 부모 모드에서는 표 칸 안의 문단에 남아 있던 노란 「AI 변경」 표시를 숨깁니다(포크 수정은 `patches/ieumoffice-clear-nested-ai-marks.patch`). 시험: `node --test host/page-live.test.mjs`.
