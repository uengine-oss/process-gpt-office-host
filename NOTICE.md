# 오픈소스 고지 — Process GPT Office (문서 편집기)

이 구성요소는 **IeumOffice**(이음오피스, https://github.com/pblsketch/openoffice)의 편집기와 문서 엔진을 웹 서비스에서 실행하도록 감싼 것이다. IeumOffice는 Apache License 2.0으로 배포되며, **GenOffice**(Copyright 2026 Mainfunc, Inc., Apache License 2.0)를 바탕으로 한다.

```
GenOffice
Copyright 2026 Mainfunc, Inc.

This product includes software developed at Mainfunc, Inc.
```

## 무엇을 바꿨나 (Apache-2.0 §4(b))

- IeumOffice 소스는 고치지 않고 그대로 쓴다.
- UENGINE Inc.가 작성한 것은 이 폴더의 연결층이다.
  - `electron` 대체 모듈, 웹 호스트(office-host), 에이전트 도구(MCP), 빌드 스크립트
- 빌드할 때 다음을 바꾼다. 원본 파일은 바뀌지 않는다.
  - 제품 이름(`packages/i18n/src/product.ts`의 `PRODUCT_NAME`과 한국어 이름)
  - AI 버튼 그림(`packages/ui/src/AiMark.tsx`): 이 연결층을 위해 새로 그린 그림으로 바꾼다.
  - 편집기 페이지 제목
- 이렇게 바꾸는 까닭은 Apache-2.0 §6이 원저작자의 이름과 상표를 쓸 권리를 주지 않기 때문이다. 이 서비스가 IeumOffice·GenOffice라는 이름으로 보이지 않게 하려는 것이다.

## 함께 배포하는 고지 (`/office/licenses/`, Docker 이미지의 `/app/licenses/`)

| 파일 | 내용 |
|---|---|
| `LICENSE` | Apache License 2.0 전문 |
| `NOTICE` | GenOffice·IeumOffice 고지: 브랜드 그림 출처, 슬라이드 템플릿(MIT), 유니코드 데이터 |
| `LICENSE-UNICODE.txt` | Unicode License v3 |
| `THIRD-PARTY-NOTICES.txt` | 번들된 npm 의존성, 글꼴(SIL OFL 1.1 등), WASM의 라이선스와 고지 |
| `NOTICE.md` | 이 문서 |

라이선스 확인(2026-10-23):
- 배포 의존성 라이선스는 모두 허용 목록 안이다(`ieumoffice`의 `node tools/check-licenses.mjs` 통과). 카피레프트(GPL·AGPL·LGPL)는 없다.
- 한글 엔진 rhwp는 MIT, xlsx 엔진은 Apache-2.0이다(cargo-deny 허용 목록).

## 한글(HWP) 공개 문서 조건

한글 편집기는 rhwp(MIT, https://github.com/edwardkim/rhwp)를 바탕으로 한다. 한글과컴퓨터가 HWP 형식 문서를 공개하며 붙인 조건에 따라 다음 문구를 밝힌다.

> 본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.

## 상표

- "IeumOffice", "이음오피스", "GenOffice", "Genspark"는 각 소유자의 이름이나 상표다. 이 서비스는 그 소유자들과 제휴하거나 후원·보증을 받은 관계가 아니다.
- "한글", "한컴", "HWP", "HWPX"는 주식회사 한글과컴퓨터의 등록 상표다.
- "Microsoft", "Word", "Excel", "PowerPoint"는 Microsoft Corporation의 상표다.
- 이 문서에서는 무엇을 바탕으로 만들었고 어떤 형식의 파일을 여는지 알리기 위해서만 그 이름을 적는다.

## 라이선스의 관계

- IeumOffice·GenOffice에서 온 코드는 계속 Apache-2.0이다. 이 서비스와 함께 배포해도 그 권리는 줄어들지 않는다.
- UENGINE Inc.가 작성한 연결층과 Process GPT의 코드에는 각자의 라이선스가 적용된다.
  - process-gpt 저장소 루트: MIT
  - 프론트엔드: Process GPT License(Apache 2.0 + Commons Clause)
- Apache-2.0은 다른 조건의 저작물과 함께 배포하는 것을 허용한다. 조건은 위 고지를 함께 내는 것이다(§4).
