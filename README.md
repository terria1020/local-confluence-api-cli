# local-confluence-api-cli

Atlassian Confluence Cloud REST API를 사용하는 CLI 도구입니다.
페이지 생성/수정, 라벨·프로퍼티 등 메타데이터 관리, 첨부파일 업로드·다운로드를 지원합니다.

AI 모델(Claude 등)이 MCP 도구로 사용하기 적합하도록 설계되었으며,
모든 결과는 JSON으로 stdout에 출력되고 로그는 stderr 및 파일로 분리됩니다.

---

## 설치

```bash
git clone https://github.com/yourorg/local-confluence-api-cli
cd local-confluence-api-cli
npm install
```

---

## 환경 변수 설정

`.env.example`을 `.env`로 복사한 후 값을 채워주세요.

```bash
cp .env.example .env
```

### `.env` 예시

```dotenv
# Atlassian 도메인 — https:// 없이 도메인만 입력
CONFLUENCE_DOMAIN=yourcompany.atlassian.net

# Atlassian 계정 이메일
CONFLUENCE_EMAIL=you@example.com

# Atlassian API 토큰
# 발급 위치: https://id.atlassian.com/manage-profile/security/api-tokens
CONFLUENCE_API_TOKEN=ATATxxxxxxxxxxxxxxxxxxxxxxxx

# 로그 레벨 (debug | info | warn | error) — 기본: info
# LOG_LEVEL=info
```

> **API 토큰 발급**: Atlassian 계정 → 보안 설정 → [API 토큰 생성](https://id.atlassian.com/manage-profile/security/api-tokens)

---

## 실행

```bash
node confluence-api-cli.js --help
node confluence-api-cli.js <command> [options]
```

전역 설치 후 사용:

```bash
npm link
confluence-api-cli --help
```

---

## 명령어 레퍼런스

### 콘텐츠 관리

---

#### `--get-page <page-id>`

페이지 정보와 본문(HTML storage format)을 조회합니다.

```bash
node confluence-api-cli.js --get-page 2569142284
```

**출력 예시**

```json
{
  "id": "2569142284",
  "title": "GAIA Observability",
  "status": "current",
  "spaceId": "790397104",
  "parentId": "1218248778",
  "version": 2,
  "createdAt": "2026-03-26T02:49:38.062Z",
  "authorId": "712020:fde15f43-...",
  "body": "<p>ONEVisionDCM 기반으로 GPU 장비의 메트릭...</p>",
  "webUrl": "https://yourcompany.atlassian.net/wiki/spaces/OX/pages/2569142284"
}
```

---

#### `--list-pages`

페이지 목록을 조회합니다.

```bash
node confluence-api-cli.js --list-pages [--space-id <id>] [--title <title>] [--limit <n>]
```

| 옵션 | 설명 | 기본값 |
|---|---|---|
| `--space-id` | 특정 스페이스 ID로 필터 | - |
| `--title` | 제목으로 필터 (부분 일치) | - |
| `--limit` | 최대 결과 수 | 25 |

```bash
# 스페이스 내 페이지 목록
node confluence-api-cli.js --list-pages --space-id 790397104 --limit 20

# 제목 필터
node confluence-api-cli.js --list-pages --title "Observability"
```

---

#### `--create-page`

새 페이지를 생성합니다.

```bash
node confluence-api-cli.js --create-page --title <title> --space-id <id> [--body <html>] [--parent-id <id>]
```

| 옵션 | 설명 | 필수 |
|---|---|---|
| `--title` | 페이지 제목 | ✅ |
| `--space-id` | 스페이스 ID (숫자 ID) | ✅ |
| `--body` | 본문 HTML (storage format) | - |
| `--parent-id` | 부모 페이지 ID (지정 시 하위 페이지로 생성) | - |

```bash
# 루트 페이지 생성
node confluence-api-cli.js --create-page \
  --title "신규 문서" \
  --space-id 790397104 \
  --body "<p>내용을 입력하세요.</p>"

# 하위 페이지 생성
node confluence-api-cli.js --create-page \
  --title "하위 문서" \
  --space-id 790397104 \
  --parent-id 2569142284 \
  --body "<h2>개요</h2><p>내용</p>"
```

> **body 형식**: Confluence storage format (HTML 기반). `<p>`, `<h1>`~`<h6>`, `<ul>`, `<ol>`, `<table>`, `<ac:structured-macro>` 등을 사용합니다.

---

#### `--update-page <page-id>`

기존 페이지를 수정합니다. 현재 버전을 자동으로 조회하여 버전을 증가시킵니다.

```bash
node confluence-api-cli.js --update-page <page-id> [--title <title>] [--body <html>]
```

| 옵션 | 설명 |
|---|---|
| `--title` | 새 제목 (생략 시 기존 제목 유지) |
| `--body` | 새 본문 HTML (생략 시 기존 본문 유지) |

```bash
# 제목만 수정
node confluence-api-cli.js --update-page 2569142284 --title "GAIA Observability v2"

# 본문만 수정
node confluence-api-cli.js --update-page 2569142284 --body "<p>업데이트된 내용</p>"

# 제목 + 본문 동시 수정
node confluence-api-cli.js --update-page 2569142284 \
  --title "새 제목" \
  --body "<p>새 내용</p>"
```

---

#### `--delete-page <page-id>`

페이지를 삭제합니다 (휴지통으로 이동).

```bash
node confluence-api-cli.js --delete-page 2569142284
```

---

#### `--get-children <page-id>`

페이지의 직접 하위 페이지 목록을 조회합니다.

```bash
node confluence-api-cli.js --get-children <page-id> [--limit <n>]
```

```bash
node confluence-api-cli.js --get-children 2569142284 --limit 50
```

---

#### `--search`

CQL(Confluence Query Language)로 콘텐츠를 검색합니다.

```bash
node confluence-api-cli.js --search --cql <query> [--limit <n>]
```

| 옵션 | 설명 | 필수 |
|---|---|---|
| `--cql` | CQL 검색 쿼리 | ✅ |
| `--limit` | 최대 결과 수 | 기본 25 |

```bash
# 제목 검색
node confluence-api-cli.js --search --cql "type=page AND title=\"GAIA Observability\""

# 스페이스 내 검색
node confluence-api-cli.js --search --cql "type=page AND space=OX AND title~\"배포\"" --limit 10

# 최근 수정 순 정렬
node confluence-api-cli.js --search --cql "type=page ORDER BY lastmodified DESC" --limit 5

# 특정 라벨이 붙은 페이지
node confluence-api-cli.js --search --cql "type=page AND label=urgent"
```

**CQL 주요 연산자**

| 연산자 | 설명 | 예시 |
|---|---|---|
| `=` | 정확히 일치 | `title="배포 가이드"` |
| `~` | 부분 일치 | `title~"배포"` |
| `AND` / `OR` | 조건 결합 | `type=page AND space=OX` |
| `ORDER BY` | 정렬 | `ORDER BY lastmodified DESC` |

---

### 메타데이터 관리

---

#### `--list-labels <page-id>`

페이지에 붙어있는 라벨 목록을 조회합니다.

```bash
node confluence-api-cli.js --list-labels 2569142284
```

---

#### `--add-labels <page-id>`

페이지에 라벨을 추가합니다.

```bash
node confluence-api-cli.js --add-labels <page-id> --labels <labels>
```

| 옵션 | 설명 |
|---|---|
| `--labels` | 쉼표 구분 문자열 또는 JSON 배열 |

```bash
# 쉼표 구분
node confluence-api-cli.js --add-labels 2569142284 --labels "bug,urgent,review"

# JSON 배열
node confluence-api-cli.js --add-labels 2569142284 --labels '["bug","urgent"]'
```

---

#### `--remove-label <page-id>`

페이지에서 특정 라벨을 제거합니다.

```bash
node confluence-api-cli.js --remove-label <page-id> --label <name>
```

```bash
node confluence-api-cli.js --remove-label 2569142284 --label "bug"
```

---

#### `--list-properties <page-id>`

페이지의 커스텀 프로퍼티 목록을 조회합니다.

```bash
node confluence-api-cli.js --list-properties 2569142284
```

---

#### `--set-property <page-id>`

페이지 프로퍼티를 생성하거나 수정합니다. 키가 없으면 생성, 있으면 수정합니다.

```bash
node confluence-api-cli.js --set-property <page-id> --key <key> --value <value>
```

| 옵션 | 설명 | 필수 |
|---|---|---|
| `--key` | 프로퍼티 키 | ✅ |
| `--value` | 문자열 또는 JSON 값 | ✅ |

```bash
# 문자열 값
node confluence-api-cli.js --set-property 2569142284 --key "status" --value "done"

# JSON 객체
node confluence-api-cli.js --set-property 2569142284 --key "deploy-info" --value '{"env":"prod","version":3}'

# 숫자
node confluence-api-cli.js --set-property 2569142284 --key "priority" --value "1"
```

---

#### `--delete-property <page-id>`

페이지 프로퍼티를 삭제합니다.

```bash
node confluence-api-cli.js --delete-property <page-id> --key <key>
```

```bash
node confluence-api-cli.js --delete-property 2569142284 --key "status"
```

---

#### `--list-versions <page-id>`

페이지의 수정 버전 히스토리를 조회합니다.

```bash
node confluence-api-cli.js --list-versions <page-id> [--limit <n>]
```

```bash
node confluence-api-cli.js --list-versions 2569142284 --limit 10
```

---

#### `--list-comments <page-id>`

페이지의 푸터 댓글 목록을 조회합니다.

```bash
node confluence-api-cli.js --list-comments <page-id> [--limit <n>]
```

```bash
node confluence-api-cli.js --list-comments 2569142284 --limit 20
```

---

#### `--add-comment <page-id>`

페이지에 댓글을 추가합니다.

```bash
node confluence-api-cli.js --add-comment <page-id> --body <html>
```

```bash
node confluence-api-cli.js --add-comment 2569142284 --body "<p>확인 부탁드립니다.</p>"
```

---

### 첨부파일 관리

---

#### `--list-attachments <page-id>`

페이지의 첨부파일 목록을 조회합니다.

```bash
node confluence-api-cli.js --list-attachments 2569142284
```

**출력 예시**

```json
{
  "pageId": "2569142284",
  "count": 2,
  "attachments": [
    {
      "id": "att-abc123",
      "title": "report.pdf",
      "mediaType": "application/pdf",
      "fileSize": 204800,
      "downloadLink": "/download/attachments/2569142284/report.pdf"
    }
  ]
}
```

---

#### `--upload-attachment <page-id>`

페이지에 파일을 업로드합니다.

```bash
node confluence-api-cli.js --upload-attachment <page-id> --file <path>
```

| 옵션 | 설명 | 필수 |
|---|---|---|
| `--file` | 업로드할 파일 경로 (절대 또는 상대 경로) | ✅ |

```bash
node confluence-api-cli.js --upload-attachment 2569142284 --file ./report.pdf
node confluence-api-cli.js --upload-attachment 2569142284 --file /tmp/architecture.png
```

---

#### `--delete-attachment <attachment-id>`

첨부파일을 삭제합니다.

```bash
node confluence-api-cli.js --delete-attachment att-abc123
```

> 첨부파일 ID는 `--list-attachments`로 확인할 수 있습니다.

---

#### `--download-attachment <attachment-id>`

첨부파일을 로컬에 다운로드합니다.

```bash
node confluence-api-cli.js --download-attachment <attachment-id> --output <path>
```

| 옵션 | 설명 | 필수 |
|---|---|---|
| `--output` | 저장할 파일 경로 | ✅ |

```bash
node confluence-api-cli.js --download-attachment att-abc123 --output ./downloaded.pdf
```

---

## 출력 형식

모든 명령어는 결과를 **JSON으로 stdout**에 출력합니다. 로그(INFO, DEBUG, ERROR)는 **stderr**와 `logs/` 디렉터리 파일로 분리됩니다.

```bash
# 결과만 파일로 저장
node confluence-api-cli.js --get-page 2569142284 2>/dev/null > page.json

# jq와 함께 사용
node confluence-api-cli.js --list-pages --space-id 790397104 2>/dev/null | jq '.pages[].title'
```

---

## 로그

| 파일 | 내용 |
|---|---|
| `logs/combined.log` | 전체 로그 |
| `logs/error.log` | 에러 로그만 |

`LOG_LEVEL=debug` 설정 시 HTTP 요청 URL 등 상세 정보가 출력됩니다.

---

## 요구 사항

- Node.js 20 이상 (native `fetch`, `FormData` 사용)
- Atlassian Confluence Cloud 계정 및 API 토큰
