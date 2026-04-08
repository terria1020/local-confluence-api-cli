#!/usr/bin/env node

/**
 * confluence-api-cli.js
 *
 * A CLI tool for interacting with Confluence Cloud REST API v2
 * - Content management: create, read, update, delete pages
 * - Metadata management: labels, properties, versions, comments
 * - Attachment management: upload, list, delete, download
 *
 * Credentials are managed via environment variables:
 *   CONFLUENCE_DOMAIN   - e.g. yourcompany.atlassian.net
 *   CONFLUENCE_EMAIL    - Atlassian account email
 *   CONFLUENCE_API_TOKEN - API token from id.atlassian.com/manage-profile/security/api-tokens
 *
 * Usage:
 *   node confluence-api-cli.js --help
 *   node confluence-api-cli.js --get-page <page-id>
 *   node confluence-api-cli.js --create-page --title "제목" --space-id "~12345" --body "<p>내용</p>"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const winston = require('winston');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

// ─── Constants ────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(process.cwd(), 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const APP_NAME = 'confluence-api-cli';

// ─── Logger ────────────────────────────────────────────────────────────────────

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    if (stack) {
      return `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}`;
    }
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      ),
      stream: process.stderr,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.level = 'debug';
}

let _exiting = false;
const CLI_EXIT = Symbol('CLI_EXIT');

function exitCli(code) {
  if (_exiting) return;
  _exiting = true;
  logger.end?.() || logger.close?.();
  setTimeout(() => process.exit(code), 50);
}

function die(msg) {
  logger.error(msg);
  exitCli(1);
  throw CLI_EXIT;
}

// ─── Confluence Client ────────────────────────────────────────────────────────

function initClient() {
  const domain = process.env.CONFLUENCE_DOMAIN;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;

  if (!domain) die('CONFLUENCE_DOMAIN environment variable not set.');
  if (!email) die('CONFLUENCE_EMAIL environment variable not set.');
  if (!token) die('CONFLUENCE_API_TOKEN environment variable not set.');

  const baseAuth = Buffer.from(`${email}:${token}`).toString('base64');
  const baseUrl = `https://${domain}/wiki`;

  logger.debug(`Confluence client initialized for domain: ${domain}`);

  async function request(method, endpoint, body = null, isV1 = false) {
    const apiBase = isV1 ? `${baseUrl}/rest/api` : `${baseUrl}/api/v2`;
    const url = `${apiBase}${endpoint}`;

    const headers = {
      'Authorization': `Basic ${baseAuth}`,
      'Accept': 'application/json',
    };

    const options = { method, headers };

    if (body !== null && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      options.body = body;
    }

    logger.debug(`${method} ${url}`);

    const res = await fetch(url, options);

    if (res.status === 204) {
      return null;
    }

    const text = await res.text();

    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.message || parsed.errors?.map(e => e.message).join(', ') || text;
      } catch (_) {}
      die(`Confluence API error ${res.status}: ${detail}`);
    }

    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  async function downloadRaw(endpoint) {
    const url = `${baseUrl}/api/v2${endpoint}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Basic ${baseAuth}` },
      redirect: 'follow',
    });

    if (!res.ok) {
      die(`Download failed with status ${res.status}`);
    }

    return res;
  }

  return { request, downloadRaw, baseUrl };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function parseJsonOption(jsonString, optionName) {
  if (!jsonString) die(`--${optionName} requires a JSON string`);
  try {
    return JSON.parse(jsonString);
  } catch (err) {
    die(`Invalid JSON for --${optionName}: ${err.message}`);
  }
}

function parseIntOption(value, optionName, defaultVal) {
  if (value === undefined || value === null) return defaultVal;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) die(`--${optionName} must be a positive integer`);
  return n;
}

function buildQueryString(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// ─── Content Management ───────────────────────────────────────────────────────

async function getPage(client, pageId) {
  logger.info(`Fetching page: ${pageId}`);
  const data = await client.request('GET', `/pages/${pageId}?body-format=storage`);
  console.log(JSON.stringify({
    id: data.id,
    title: data.title,
    status: data.status,
    spaceId: data.spaceId,
    parentId: data.parentId,
    version: data.version?.number,
    createdAt: data.createdAt,
    authorId: data.ownerId,
    body: data.body?.storage?.value || '',
    webUrl: data._links?.webui ? `https://${process.env.CONFLUENCE_DOMAIN}/wiki${data._links.webui}` : null,
  }, null, 2));
}

async function listPages(client, spaceId, title, limit) {
  logger.info('Listing pages');
  const qs = buildQueryString({ 'space-id': spaceId, title, limit });
  const data = await client.request('GET', `/pages${qs}`);
  const results = (data.results || []).map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    spaceId: p.spaceId,
    parentId: p.parentId,
    version: p.version?.number,
  }));
  console.log(JSON.stringify({ count: results.length, pages: results }, null, 2));
}

async function createPage(client, title, spaceId, body, parentId) {
  if (!title) die('--title is required for --create-page');
  if (!spaceId) die('--space-id is required for --create-page');

  logger.info(`Creating page: "${title}" in space ${spaceId}`);

  const payload = {
    spaceId,
    status: 'current',
    title,
    body: {
      representation: 'storage',
      value: body || '',
    },
  };

  if (parentId) payload.parentId = parentId;

  const data = await client.request('POST', '/pages', payload);
  console.log(JSON.stringify({
    id: data.id,
    title: data.title,
    status: data.status,
    spaceId: data.spaceId,
    parentId: data.parentId,
    version: data.version?.number,
    webUrl: data._links?.webui ? `https://${process.env.CONFLUENCE_DOMAIN}/wiki${data._links.webui}` : null,
  }, null, 2));
}

async function updatePage(client, pageId, title, body) {
  if (!title && body === undefined) die('--update-page requires at least --title or --body');

  logger.info(`Fetching current version for page: ${pageId}`);
  const current = await client.request('GET', `/pages/${pageId}?body-format=storage`);
  const currentVersion = current.version?.number || 1;

  const payload = {
    id: pageId,
    status: 'current',
    title: title || current.title,
    version: { number: currentVersion + 1 },
    body: {
      representation: 'storage',
      value: body !== undefined ? body : (current.body?.storage?.value || ''),
    },
  };

  logger.info(`Updating page: ${pageId} (version ${currentVersion} → ${currentVersion + 1})`);
  const data = await client.request('PUT', `/pages/${pageId}`, payload);
  console.log(JSON.stringify({
    id: data.id,
    title: data.title,
    version: data.version?.number,
    status: data.status,
  }, null, 2));
}

async function deletePage(client, pageId) {
  logger.info(`Deleting page: ${pageId}`);
  await client.request('DELETE', `/pages/${pageId}`);
  console.log(JSON.stringify({ success: true, pageId, message: 'Page moved to trash' }, null, 2));
}

async function getChildren(client, pageId, limit) {
  logger.info(`Fetching children of page: ${pageId}`);
  const qs = buildQueryString({ limit });
  const data = await client.request('GET', `/pages/${pageId}/children${qs}`);
  const results = (data.results || []).map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    spaceId: p.spaceId,
    version: p.version?.number,
  }));
  console.log(JSON.stringify({ parentId: pageId, count: results.length, children: results }, null, 2));
}

async function search(client, cql, limit) {
  if (!cql) die('--cql is required for --search');
  logger.info(`Searching with CQL: ${cql}`);
  const qs = buildQueryString({ cql, limit });
  const data = await client.request('GET', `/search${qs}`, null, true);
  const results = (data.results || []).map(r => ({
    id: r.content?.id,
    type: r.content?.type,
    title: r.content?.title,
    space: r.resultParentContainer?.title || r.space?.name,
    url: r.url,
    lastModified: r.lastModified,
    excerpt: r.excerpt,
  }));
  console.log(JSON.stringify({ total: data.totalSize, count: results.length, results }, null, 2));
}

// ─── Metadata: Labels ─────────────────────────────────────────────────────────

async function listLabels(client, pageId) {
  logger.info(`Fetching labels for page: ${pageId}`);
  const data = await client.request('GET', `/pages/${pageId}/labels`);
  const labels = (data.results || []).map(l => ({
    id: l.id,
    name: l.name,
    prefix: l.prefix,
  }));
  console.log(JSON.stringify({ pageId, count: labels.length, labels }, null, 2));
}

async function addLabels(client, pageId, labelsInput) {
  if (!labelsInput) die('--labels is required for --add-labels (comma-separated or JSON array)');

  let names;
  if (labelsInput.startsWith('[')) {
    names = parseJsonOption(labelsInput, 'labels');
  } else {
    names = labelsInput.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (!names.length) die('No labels provided');

  logger.info(`Adding labels to page ${pageId}: ${names.join(', ')}`);
  const payload = names.map(name => ({ name, prefix: 'global' }));
  const data = await client.request('POST', `/pages/${pageId}/labels`, payload);
  const labels = (data.results || []).map(l => ({ id: l.id, name: l.name, prefix: l.prefix }));
  console.log(JSON.stringify({ pageId, added: names, labels }, null, 2));
}

async function removeLabel(client, pageId, labelName) {
  if (!labelName) die('--label is required for --remove-label');
  logger.info(`Removing label "${labelName}" from page ${pageId}`);

  const listData = await client.request('GET', `/pages/${pageId}/labels`);
  const found = (listData.results || []).find(l => l.name === labelName);
  if (!found) die(`Label "${labelName}" not found on page ${pageId}`);

  await client.request('DELETE', `/pages/${pageId}/labels/${found.id}`);
  console.log(JSON.stringify({ success: true, pageId, removedLabel: labelName }, null, 2));
}

// ─── Metadata: Properties ─────────────────────────────────────────────────────

async function listProperties(client, pageId) {
  logger.info(`Fetching properties for page: ${pageId}`);
  const data = await client.request('GET', `/pages/${pageId}/properties`);
  const props = (data.results || []).map(p => ({
    id: p.id,
    key: p.key,
    value: p.value,
    version: p.version?.number,
  }));
  console.log(JSON.stringify({ pageId, count: props.length, properties: props }, null, 2));
}

async function setProperty(client, pageId, key, valueInput) {
  if (!key) die('--key is required for --set-property');
  if (valueInput === undefined || valueInput === null) die('--value is required for --set-property');

  let value;
  try {
    value = JSON.parse(valueInput);
  } catch (_) {
    value = valueInput;
  }

  // Check if property already exists to decide POST vs PUT
  let existing = null;
  try {
    existing = await client.request('GET', `/pages/${pageId}/properties/${key}`);
  } catch (_) {}

  if (existing) {
    const currentVersion = existing.version?.number || 1;
    logger.info(`Updating property "${key}" on page ${pageId} (version ${currentVersion} → ${currentVersion + 1})`);
    const payload = { key, value, version: { number: currentVersion + 1 } };
    const data = await client.request('PUT', `/pages/${pageId}/properties/${key}`, payload);
    console.log(JSON.stringify({ pageId, key: data.key, value: data.value, version: data.version?.number }, null, 2));
  } else {
    logger.info(`Creating property "${key}" on page ${pageId}`);
    const payload = { key, value };
    const data = await client.request('POST', `/pages/${pageId}/properties`, payload);
    console.log(JSON.stringify({ pageId, key: data.key, value: data.value, version: data.version?.number }, null, 2));
  }
}

async function deleteProperty(client, pageId, key) {
  if (!key) die('--key is required for --delete-property');
  logger.info(`Deleting property "${key}" from page ${pageId}`);
  await client.request('DELETE', `/pages/${pageId}/properties/${key}`);
  console.log(JSON.stringify({ success: true, pageId, deletedKey: key }, null, 2));
}

// ─── Metadata: Versions ───────────────────────────────────────────────────────

async function listVersions(client, pageId, limit) {
  logger.info(`Fetching versions for page: ${pageId}`);
  const qs = buildQueryString({ limit });
  const data = await client.request('GET', `/pages/${pageId}/versions${qs}`);
  const versions = (data.results || []).map(v => ({
    number: v.number,
    authorId: v.authorId,
    createdAt: v.createdAt,
    message: v.message || null,
    minorEdit: v.minorEdit,
  }));
  console.log(JSON.stringify({ pageId, count: versions.length, versions }, null, 2));
}

// ─── Metadata: Comments ───────────────────────────────────────────────────────

async function listComments(client, pageId, limit) {
  logger.info(`Fetching footer comments for page: ${pageId}`);
  const qs = buildQueryString({ limit });
  const data = await client.request('GET', `/pages/${pageId}/footer-comments${qs}`);
  const comments = (data.results || []).map(c => ({
    id: c.id,
    status: c.status,
    createdAt: c.createdAt,
    version: c.version?.number,
    body: c.body?.storage?.value || '',
  }));
  console.log(JSON.stringify({ pageId, count: comments.length, comments }, null, 2));
}

async function addComment(client, pageId, body) {
  if (!body) die('--body is required for --add-comment');
  logger.info(`Adding comment to page: ${pageId}`);
  const payload = {
    pageId,
    body: {
      representation: 'storage',
      value: body,
    },
  };
  const data = await client.request('POST', '/footer-comments', payload);
  console.log(JSON.stringify({
    id: data.id,
    pageId: data.pageId,
    status: data.status,
    createdAt: data.createdAt,
    body: data.body?.storage?.value || body,
  }, null, 2));
}

// ─── Attachment Management ────────────────────────────────────────────────────

async function listAttachments(client, pageId) {
  logger.info(`Fetching attachments for page: ${pageId}`);
  const qs = buildQueryString({ 'pageId': pageId });
  const data = await client.request('GET', `/attachments${qs}`);
  const attachments = (data.results || []).map(a => ({
    id: a.id,
    title: a.title,
    mediaType: a.mediaType,
    fileSize: a.fileSize,
    webuiLink: a.webuiLink,
    downloadLink: a.downloadLink,
  }));
  console.log(JSON.stringify({ pageId, count: attachments.length, attachments }, null, 2));
}

async function uploadAttachment(client, pageId, filePath) {
  if (!filePath) die('--file is required for --upload-attachment');
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) die(`File not found: ${resolvedPath}`);

  const filename = path.basename(resolvedPath);
  const fileBuffer = fs.readFileSync(resolvedPath);
  const fileBlob = new Blob([fileBuffer]);

  logger.info(`Uploading "${filename}" to page: ${pageId}`);

  const formData = new FormData();
  formData.append('file', fileBlob, filename);
  formData.append('comment', `Uploaded via ${APP_NAME}`);
  formData.append('minorEdit', 'true');

  const domain = process.env.CONFLUENCE_DOMAIN;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  const baseAuth = Buffer.from(`${email}:${token}`).toString('base64');

  const url = `https://${domain}/wiki/api/v2/pages/${pageId}/attachments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${baseAuth}`,
      'Accept': 'application/json',
      'X-Atlassian-Token': 'no-check',
    },
    body: formData,
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || text;
    } catch (_) {}
    die(`Upload failed ${res.status}: ${detail}`);
  }

  const data = JSON.parse(text);
  const results = (data.results || [data]).map(a => ({
    id: a.id,
    title: a.title,
    mediaType: a.mediaType,
    fileSize: a.fileSize,
    downloadLink: a.downloadLink,
  }));

  console.log(JSON.stringify({ pageId, uploaded: filename, attachments: results }, null, 2));
}

async function deleteAttachment(client, attachmentId) {
  logger.info(`Deleting attachment: ${attachmentId}`);
  await client.request('DELETE', `/attachments/${attachmentId}`);
  console.log(JSON.stringify({ success: true, attachmentId, message: 'Attachment deleted' }, null, 2));
}

async function downloadAttachment(client, attachmentId, outputPath) {
  if (!outputPath) die('--output is required for --download-attachment');

  logger.info(`Fetching attachment info: ${attachmentId}`);
  const info = await client.request('GET', `/attachments/${attachmentId}`);
  const filename = info.title || attachmentId;

  logger.info(`Downloading attachment: ${filename}`);
  const res = await client.downloadRaw(`/attachments/${attachmentId}/download`);

  const resolvedOutput = path.resolve(outputPath);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(resolvedOutput, buffer);

  console.log(JSON.stringify({
    attachmentId,
    title: filename,
    savedTo: resolvedOutput,
    bytes: buffer.length,
  }, null, 2));
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
Usage: confluence-api-cli [command] [options]

─── Content Management ───────────────────────────────────────────────────────

  --get-page <page-id>              페이지 조회 (본문 포함)
  --list-pages                      페이지 목록 조회
  --create-page                     새 페이지 생성
  --update-page <page-id>           페이지 수정 (버전 자동 증가)
  --delete-page <page-id>           페이지 삭제 (휴지통 이동)
  --get-children <page-id>          자식 페이지 목록
  --search                          CQL 검색

─── Metadata Management ──────────────────────────────────────────────────────

  --list-labels <page-id>           페이지 라벨 목록
  --add-labels <page-id>            라벨 추가
  --remove-label <page-id>          라벨 삭제
  --list-properties <page-id>       페이지 프로퍼티 목록
  --set-property <page-id>          프로퍼티 생성/수정
  --delete-property <page-id>       프로퍼티 삭제
  --list-versions <page-id>         버전 히스토리
  --list-comments <page-id>         페이지 댓글 목록
  --add-comment <page-id>           댓글 추가

─── Attachment Management ────────────────────────────────────────────────────

  --list-attachments <page-id>      첨부파일 목록
  --upload-attachment <page-id>     파일 업로드
  --delete-attachment <attach-id>   첨부파일 삭제
  --download-attachment <attach-id> 첨부파일 다운로드

─── Options ──────────────────────────────────────────────────────────────────

  --list-pages options:
    --space-id <id>                 스페이스 ID로 필터
    --title <title>                 제목으로 필터
    --limit <n>                     결과 개수 제한 (기본: 25)

  --create-page options:
    --title <title>                 페이지 제목 (필수)
    --space-id <id>                 스페이스 ID (필수, e.g. ~12345 or spaceKey)
    --body <html>                   페이지 본문 HTML (storage format)
    --parent-id <id>                부모 페이지 ID

  --update-page options:
    --title <title>                 새 제목 (선택)
    --body <html>                   새 본문 HTML (선택)

  --get-children / --list-versions / --list-comments options:
    --limit <n>                     결과 개수 제한

  --search options:
    --cql <query>                   CQL 검색 쿼리 (필수)
                                    예: "type=page AND space=MY-SPACE"
    --limit <n>                     결과 개수 제한 (기본: 25)

  --add-labels options:
    --labels <labels>               쉼표 구분 또는 JSON 배열
                                    예: "bug,urgent" 또는 '["bug","urgent"]'

  --remove-label options:
    --label <name>                  삭제할 라벨 이름

  --set-property options:
    --key <key>                     프로퍼티 키 (필수)
    --value <value>                 프로퍼티 값 - 문자열 또는 JSON (필수)

  --delete-property options:
    --key <key>                     삭제할 프로퍼티 키 (필수)

  --add-comment options:
    --body <html>                   댓글 본문 HTML (storage format) (필수)

  --upload-attachment options:
    --file <path>                   업로드할 파일 경로 (필수)

  --download-attachment options:
    --output <path>                 저장 경로 (필수)

─── Examples ─────────────────────────────────────────────────────────────────

  node confluence-api-cli.js --get-page 123456789
  node confluence-api-cli.js --list-pages --space-id "~12345" --limit 10
  node confluence-api-cli.js --create-page --title "신규 페이지" --space-id "~12345" --body "<p>내용</p>"
  node confluence-api-cli.js --create-page --title "하위 페이지" --space-id "~12345" --parent-id 123456789 --body "<p>내용</p>"
  node confluence-api-cli.js --update-page 123456789 --title "수정된 제목" --body "<p>수정된 내용</p>"
  node confluence-api-cli.js --delete-page 123456789
  node confluence-api-cli.js --get-children 123456789 --limit 20
  node confluence-api-cli.js --search --cql "type=page AND title~\"배포\"" --limit 10

  node confluence-api-cli.js --list-labels 123456789
  node confluence-api-cli.js --add-labels 123456789 --labels "bug,urgent"
  node confluence-api-cli.js --remove-label 123456789 --label "bug"
  node confluence-api-cli.js --list-properties 123456789
  node confluence-api-cli.js --set-property 123456789 --key "status" --value "done"
  node confluence-api-cli.js --set-property 123456789 --key "meta" --value '{"env":"prod","version":2}'
  node confluence-api-cli.js --delete-property 123456789 --key "status"
  node confluence-api-cli.js --list-versions 123456789 --limit 5
  node confluence-api-cli.js --list-comments 123456789
  node confluence-api-cli.js --add-comment 123456789 --body "<p>확인 부탁드립니다.</p>"

  node confluence-api-cli.js --list-attachments 123456789
  node confluence-api-cli.js --upload-attachment 123456789 --file ./report.pdf
  node confluence-api-cli.js --delete-attachment att-abc123
  node confluence-api-cli.js --download-attachment att-abc123 --output ./downloaded.pdf

─── Environment ──────────────────────────────────────────────────────────────

  CONFLUENCE_DOMAIN       Atlassian 도메인 (예: yourcompany.atlassian.net)
  CONFLUENCE_EMAIL        Atlassian 계정 이메일
  CONFLUENCE_API_TOKEN    API 토큰 (https://id.atlassian.com/manage-profile/security/api-tokens)
  LOG_LEVEL               로그 레벨 (기본: info)

─── Setup ────────────────────────────────────────────────────────────────────

  1. .env.example 을 .env 로 복사
  2. CONFLUENCE_DOMAIN, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN 설정
  3. CLI 실행
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    exitCli(0);
    return;
  }

  try {
    const client = initClient();
    const cmd = args[0];

    // ── Content Management ──────────────────────────────────────────────────

    if (cmd === '--get-page') {
      const pageId = args[1];
      if (!pageId) die('--get-page requires a page ID');
      await getPage(client, pageId);

    } else if (cmd === '--list-pages') {
      let spaceId = null, title = null, limit = 25;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--space-id' && args[i + 1]) spaceId = args[++i];
        else if (args[i] === '--title' && args[i + 1]) title = args[++i];
        else if (args[i] === '--limit' && args[i + 1]) limit = parseIntOption(args[++i], 'limit', 25);
      }
      await listPages(client, spaceId, title, limit);

    } else if (cmd === '--create-page') {
      let title = null, spaceId = null, body = '', parentId = null;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--title' && args[i + 1]) title = args[++i];
        else if (args[i] === '--space-id' && args[i + 1]) spaceId = args[++i];
        else if (args[i] === '--body' && args[i + 1]) body = args[++i];
        else if (args[i] === '--parent-id' && args[i + 1]) parentId = args[++i];
      }
      await createPage(client, title, spaceId, body, parentId);

    } else if (cmd === '--update-page') {
      const pageId = args[1];
      if (!pageId) die('--update-page requires a page ID');
      let title = null, body = undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--title' && args[i + 1]) title = args[++i];
        else if (args[i] === '--body' && args[i + 1]) body = args[++i];
      }
      await updatePage(client, pageId, title, body);

    } else if (cmd === '--delete-page') {
      const pageId = args[1];
      if (!pageId) die('--delete-page requires a page ID');
      await deletePage(client, pageId);

    } else if (cmd === '--get-children') {
      const pageId = args[1];
      if (!pageId) die('--get-children requires a page ID');
      let limit = 25;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) limit = parseIntOption(args[++i], 'limit', 25);
      }
      await getChildren(client, pageId, limit);

    } else if (cmd === '--search') {
      let cql = null, limit = 25;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--cql' && args[i + 1]) cql = args[++i];
        else if (args[i] === '--limit' && args[i + 1]) limit = parseIntOption(args[++i], 'limit', 25);
      }
      await search(client, cql, limit);

    // ── Metadata: Labels ───────────────────────────────────────────────────

    } else if (cmd === '--list-labels') {
      const pageId = args[1];
      if (!pageId) die('--list-labels requires a page ID');
      await listLabels(client, pageId);

    } else if (cmd === '--add-labels') {
      const pageId = args[1];
      if (!pageId) die('--add-labels requires a page ID');
      let labels = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--labels' && args[i + 1]) labels = args[++i];
      }
      await addLabels(client, pageId, labels);

    } else if (cmd === '--remove-label') {
      const pageId = args[1];
      if (!pageId) die('--remove-label requires a page ID');
      let label = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--label' && args[i + 1]) label = args[++i];
      }
      await removeLabel(client, pageId, label);

    // ── Metadata: Properties ───────────────────────────────────────────────

    } else if (cmd === '--list-properties') {
      const pageId = args[1];
      if (!pageId) die('--list-properties requires a page ID');
      await listProperties(client, pageId);

    } else if (cmd === '--set-property') {
      const pageId = args[1];
      if (!pageId) die('--set-property requires a page ID');
      let key = null, value = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--key' && args[i + 1]) key = args[++i];
        else if (args[i] === '--value' && args[i + 1]) value = args[++i];
      }
      await setProperty(client, pageId, key, value);

    } else if (cmd === '--delete-property') {
      const pageId = args[1];
      if (!pageId) die('--delete-property requires a page ID');
      let key = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--key' && args[i + 1]) key = args[++i];
      }
      await deleteProperty(client, pageId, key);

    // ── Metadata: Versions ─────────────────────────────────────────────────

    } else if (cmd === '--list-versions') {
      const pageId = args[1];
      if (!pageId) die('--list-versions requires a page ID');
      let limit = 25;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) limit = parseIntOption(args[++i], 'limit', 25);
      }
      await listVersions(client, pageId, limit);

    // ── Metadata: Comments ─────────────────────────────────────────────────

    } else if (cmd === '--list-comments') {
      const pageId = args[1];
      if (!pageId) die('--list-comments requires a page ID');
      let limit = 25;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) limit = parseIntOption(args[++i], 'limit', 25);
      }
      await listComments(client, pageId, limit);

    } else if (cmd === '--add-comment') {
      const pageId = args[1];
      if (!pageId) die('--add-comment requires a page ID');
      let body = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--body' && args[i + 1]) body = args[++i];
      }
      await addComment(client, pageId, body);

    // ── Attachment Management ──────────────────────────────────────────────

    } else if (cmd === '--list-attachments') {
      const pageId = args[1];
      if (!pageId) die('--list-attachments requires a page ID');
      await listAttachments(client, pageId);

    } else if (cmd === '--upload-attachment') {
      const pageId = args[1];
      if (!pageId) die('--upload-attachment requires a page ID');
      let filePath = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--file' && args[i + 1]) filePath = args[++i];
      }
      await uploadAttachment(client, pageId, filePath);

    } else if (cmd === '--delete-attachment') {
      const attachmentId = args[1];
      if (!attachmentId) die('--delete-attachment requires an attachment ID');
      await deleteAttachment(client, attachmentId);

    } else if (cmd === '--download-attachment') {
      const attachmentId = args[1];
      if (!attachmentId) die('--download-attachment requires an attachment ID');
      let outputPath = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--output' && args[i + 1]) outputPath = args[++i];
      }
      await downloadAttachment(client, attachmentId, outputPath);

    } else {
      die(`Unknown command: ${cmd}\nRun with --help to see available commands.`);
    }

  } catch (err) {
    if (err !== CLI_EXIT) {
      logger.error(`Unexpected error: ${err.message}`);
      exitCli(1);
    }
  }
}

main();
