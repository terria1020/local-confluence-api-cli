#!/usr/bin/env node

/**
 * confluence-api-cli.js
 *
 * A CLI tool for interacting with Confluence Cloud REST API v1/v2
 * - Content management: create, read, update, delete pages
 * - Metadata management: labels, properties, versions, comments
 * - Attachment management: upload, list, delete, download
 *
 * Credentials are managed via environment variables:
 *   CONFLUENCE_DOMAIN       - e.g. yourcompany.atlassian.net
 *   CONFLUENCE_CONTEXT_PATH - e.g. /wiki or /confluence
 *   CONFLUENCE_BASE_URL     - full base URL override
 *   CONFLUENCE_EMAIL        - Atlassian account email (cloud basic auth)
 *   CONFLUENCE_USERNAME     - username (server basic auth)
 *   CONFLUENCE_API_TOKEN    - API token (cloud basic auth)
 *   CONFLUENCE_SECRET       - password / PAT / bearer token
 *   CONFLUENCE_AUTH_TYPE    - basic | bearer (default: basic)
 *     basic  = CONFLUENCE_EMAIL/CONFLUENCE_USERNAME + CONFLUENCE_API_TOKEN/CONFLUENCE_SECRET
 *              를 "Authorization: Basic <base64>"로 전송. Cloud API 토큰,
 *              Server/DC 계정 비밀번호나 PAT를 그대로 쓸 때 선택.
 *     bearer = CONFLUENCE_SECRET 하나만 "Authorization: Bearer <token>"으로 전송.
 *              Cloud OAuth access token이나 Server/DC PAT를 Bearer 헤더로 보낼 때 선택.
 *              이메일/유저명은 필요 없음.
 *   CONFLUENCE_PLATFORM     - cloud | server (선택, 미지정 시 도메인으로 자동 판별:
 *                             *.atlassian.net이면 cloud, 그 외는 server)
 *   CONFLUENCE_API_VERSION  - v1 | v2 (선택, 미지정 시 platform에 따라 자동 결정:
 *                             cloud는 v2, server는 v1)
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
  const platform = process.env.CONFLUENCE_PLATFORM
    ? normalizePlatform(process.env.CONFLUENCE_PLATFORM)
    : inferPlatform(process.env.CONFLUENCE_BASE_URL, domain);
  const contextPath = normalizeContextPath(
    process.env.CONFLUENCE_CONTEXT_PATH || (platform === 'cloud' ? '/wiki' : '')
  );
  const baseUrl = process.env.CONFLUENCE_BASE_URL || (domain ? `https://${domain}${contextPath}` : null);
  const username = process.env.CONFLUENCE_USERNAME || process.env.CONFLUENCE_EMAIL;
  const secret = process.env.CONFLUENCE_SECRET || process.env.CONFLUENCE_API_TOKEN;
  const defaultAuthType = normalizeAuthType(process.env.CONFLUENCE_AUTH_TYPE || 'basic');
  const v1AuthType = normalizeAuthType(process.env.CONFLUENCE_V1_AUTH_TYPE || defaultAuthType);
  const v2AuthType = normalizeAuthType(process.env.CONFLUENCE_V2_AUTH_TYPE || defaultAuthType);
  const defaultApiVersion = normalizeApiVersion(
    process.env.CONFLUENCE_API_VERSION || (platform === 'server' ? 'v1' : 'v2')
  );

  if (!baseUrl) die('CONFLUENCE_BASE_URL or CONFLUENCE_DOMAIN environment variable not set.');
  if (!secret) die('CONFLUENCE_SECRET or CONFLUENCE_API_TOKEN environment variable not set.');
  if (defaultAuthType === 'basic' && !username) {
    die('CONFLUENCE_USERNAME or CONFLUENCE_EMAIL environment variable not set.');
  }

  const baseAuth = username ? Buffer.from(`${username}:${secret}`).toString('base64') : null;
  const siteOrigin = new URL(baseUrl).origin;

  logger.debug(`Confluence client initialized for platform: ${platform}, baseUrl: ${baseUrl}`);

  function authTypeFor(apiVersion) {
    return apiVersion === 'v1' ? v1AuthType : v2AuthType;
  }

  function authHeaderFor(apiVersion) {
    const authType = authTypeFor(apiVersion);
    if (authType === 'bearer') return `Bearer ${secret}`;
    if (!baseAuth) die('Basic auth requires CONFLUENCE_USERNAME/CONFLUENCE_EMAIL plus CONFLUENCE_SECRET/CONFLUENCE_API_TOKEN.');
    return `Basic ${baseAuth}`;
  }

  function apiBaseFor(apiVersion) {
    if (platform === 'server') {
      if (apiVersion && normalizeApiVersion(apiVersion) !== 'v1') {
        die('Confluence Server/Data Center only supports v1 REST routes in this CLI.');
      }
      return `${baseUrl}/rest/api`;
    }
    return normalizeApiVersion(apiVersion) === 'v1' ? `${baseUrl}/rest/api` : `${baseUrl}/api/v2`;
  }

  function isV2(apiVersion = defaultApiVersion) {
    return platform === 'cloud' && normalizeApiVersion(apiVersion) === 'v2';
  }

  function webUrlFor(pathname) {
    if (!pathname) return null;
    return `${baseUrl}${pathname}`;
  }

  function pagePath(pageId, apiVersion = defaultApiVersion) {
    return isV2(apiVersion) ? `/pages/${pageId}` : `/content/${pageId}`;
  }

  function pagesCollectionPath(apiVersion = defaultApiVersion) {
    return isV2(apiVersion) ? '/pages' : '/content';
  }

  function childrenPath(pageId, apiVersion = defaultApiVersion) {
    return isV2(apiVersion) ? `/pages/${pageId}/children` : `/content/${pageId}/child/page`;
  }

  function labelsPath(pageId, apiVersion = defaultApiVersion) {
    return isV2(apiVersion) ? `/pages/${pageId}/labels` : `/content/${pageId}/label`;
  }

  function propertiesPath(pageId, apiVersion = defaultApiVersion) {
    return isV2(apiVersion) ? `/pages/${pageId}/properties` : `/content/${pageId}/property`;
  }

  function versionsPath(pageId, apiVersion = defaultApiVersion) {
    return isV2(apiVersion) ? `/pages/${pageId}/versions` : `/content/${pageId}/version`;
  }

  function commentsPath(pageId, apiVersion = defaultApiVersion) {
    return isV2(apiVersion) ? `/pages/${pageId}/footer-comments` : `/content/${pageId}/child/comment`;
  }

  function attachmentsPath(pageId, apiVersion = defaultApiVersion) {
    return isV2(apiVersion) ? `/attachments?pageId=${encodeURIComponent(pageId)}` : `/content/${pageId}/child/attachment`;
  }

  async function request(method, endpoint, body = null, apiVersion = defaultApiVersion) {
    const resolvedVersion = normalizeApiVersion(apiVersion);
    const apiBase = apiBaseFor(resolvedVersion);
    const url = `${apiBase}${endpoint}`;

    const headers = {
      'Authorization': authHeaderFor(resolvedVersion),
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

  async function downloadRaw(endpoint, apiVersion = defaultApiVersion) {
    const resolvedVersion = normalizeApiVersion(apiVersion);
    const url = `${apiBaseFor(resolvedVersion)}${endpoint}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': authHeaderFor(resolvedVersion) },
      redirect: 'follow',
    });

    if (!res.ok) {
      die(`Download failed with status ${res.status}`);
    }

    return res;
  }

  return {
    request,
    downloadRaw,
    baseUrl,
    siteOrigin,
    platform,
    isV2,
    apiBaseFor,
    authHeaderFor,
    webUrlFor,
    pagePath,
    pagesCollectionPath,
    childrenPath,
    labelsPath,
    propertiesPath,
    versionsPath,
    commentsPath,
    attachmentsPath,
    defaultApiVersion,
  };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function normalizeAuthType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'basic';
  if (normalized === 'basic' || normalized === 'bearer') return normalized;
  die(`CONFLUENCE_AUTH_TYPE must be either "basic" or "bearer" (got "${value}")`);
}

function inferPlatform(baseUrlOverride, domain) {
  let host = '';
  try {
    host = new URL(baseUrlOverride || `https://${domain || ''}`).hostname;
  } catch (_) {
    host = domain || '';
  }
  const platform = /(^|\.)atlassian\.net$/i.test(host) ? 'cloud' : 'server';
  logger.debug(`CONFLUENCE_PLATFORM not set, inferred "${platform}" from host: ${host}`);
  return platform;
}

function normalizePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'cloud' || normalized === 'on-demand' || normalized === 'ondemand') return 'cloud';
  if (normalized === 'server' || normalized === 'dc' || normalized === 'datacenter' || normalized === 'data-center' || normalized === 'onprem' || normalized === 'on-prem') {
    return 'server';
  }
  die(`CONFLUENCE_PLATFORM must be either "cloud" or "server" (got "${value}")`);
}

function normalizeContextPath(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '/') return '';
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

function normalizeApiVersion(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'v2';
  if (normalized === 'v1' || normalized === 'v2') return normalized;
  die(`CONFLUENCE_API_VERSION must be either "v1" or "v2" (got "${value}")`);
}

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
  const endpoint = client.isV2()
    ? `${client.pagePath(pageId)}?body-format=storage`
    : `${client.pagePath(pageId)}?expand=body.storage,version,space,ancestors`;
  const data = await client.request('GET', endpoint);
  console.log(JSON.stringify({
    id: data.id,
    title: data.title,
    status: data.status,
    spaceId: data.spaceId || data.space?.key || null,
    parentId: data.parentId || data.ancestors?.[data.ancestors.length - 1]?.id || null,
    version: data.version?.number,
    createdAt: data.createdAt,
    authorId: data.ownerId,
    body: data.body?.storage?.value || '',
    webUrl: client.webUrlFor(data._links?.webui || data._links?.base || null),
  }, null, 2));
}

async function listPages(client, spaceId, title, limit) {
  logger.info('Listing pages');
  const qs = client.isV2()
    ? buildQueryString({ 'space-id': spaceId, title, limit })
    : buildQueryString({ type: 'page', spaceKey: spaceId, title, limit });
  const data = await client.request('GET', `${client.pagesCollectionPath()}${qs}`);
  const results = (data.results || []).map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    spaceId: p.spaceId || p.space?.key || null,
    parentId: p.parentId || p.ancestors?.[p.ancestors.length - 1]?.id || null,
    version: p.version?.number,
  }));
  console.log(JSON.stringify({ count: results.length, pages: results }, null, 2));
}

async function createPage(client, title, spaceId, body, parentId) {
  if (!title) die('--title is required for --create-page');
  if (!spaceId) die('--space-id is required for --create-page');

  logger.info(`Creating page: "${title}" in space ${spaceId}`);

  if (client.isV2()) {
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
      webUrl: client.webUrlFor(data._links?.webui || data._links?.base || null),
    }, null, 2));
    return;
  }

  const payload = {
    type: 'page',
    title,
    space: { key: spaceId },
    body: {
      storage: {
        representation: 'storage',
        value: body || '',
      },
    },
  };
  if (parentId) payload.ancestors = [{ id: parentId }];

  const data = await client.request('POST', '/content', payload);
  console.log(JSON.stringify({
    id: data.id,
    title: data.title,
    status: data.status,
    spaceId: data.spaceId || data.space?.key || null,
    parentId: data.parentId || data.ancestors?.[data.ancestors.length - 1]?.id || null,
    version: data.version?.number,
    webUrl: client.webUrlFor(data._links?.webui || data._links?.base || null),
  }, null, 2));
}

async function updatePage(client, pageId, title, body) {
  if (!title && body === undefined) die('--update-page requires at least --title or --body');

  logger.info(`Fetching current version for page: ${pageId}`);
  const current = await client.request('GET', client.isV2()
    ? `${client.pagePath(pageId)}?body-format=storage`
    : `${client.pagePath(pageId)}?expand=body.storage,version,space,ancestors`);
  const currentVersion = current.version?.number || 1;

  logger.info(`Updating page: ${pageId} (version ${currentVersion} → ${currentVersion + 1})`);
  const data = client.isV2()
    ? await client.request('PUT', client.pagePath(pageId), {
        id: pageId,
        status: 'current',
        title: title || current.title,
        version: { number: currentVersion + 1 },
        body: {
          representation: 'storage',
          value: body !== undefined ? body : (current.body?.storage?.value || ''),
        },
      })
    : await client.request('PUT', client.pagePath(pageId), {
        id: pageId,
        type: 'page',
        title: title || current.title,
        version: { number: currentVersion + 1 },
        space: { key: current.spaceId || current.space?.key },
        body: {
          storage: {
            representation: 'storage',
            value: body !== undefined ? body : (current.body?.storage?.value || ''),
          },
        },
      });
  console.log(JSON.stringify({
    id: data.id,
    title: data.title,
    version: data.version?.number,
    status: data.status,
  }, null, 2));
}

async function deletePage(client, pageId) {
  logger.info(`Deleting page: ${pageId}`);
  await client.request('DELETE', client.pagePath(pageId));
  console.log(JSON.stringify({ success: true, pageId, message: 'Page moved to trash' }, null, 2));
}

async function getChildren(client, pageId, limit) {
  logger.info(`Fetching children of page: ${pageId}`);
  const qs = buildQueryString({ limit });
  const data = await client.request('GET', `${client.childrenPath(pageId)}${qs}`);
  const results = (data.results || []).map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    spaceId: p.spaceId || p.space?.key || null,
    version: p.version?.number,
  }));
  console.log(JSON.stringify({ parentId: pageId, count: results.length, children: results }, null, 2));
}

async function search(client, cql, limit) {
  if (!cql) die('--cql is required for --search');
  logger.info(`Searching with CQL: ${cql}`);
  const qs = buildQueryString({ cql, limit });
  const data = await client.request('GET', `/search${qs}`, null, 'v1');
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
  const data = await client.request('GET', client.labelsPath(pageId));
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
  const data = await client.request('POST', client.labelsPath(pageId), payload);
  const labels = (data.results || []).map(l => ({ id: l.id, name: l.name, prefix: l.prefix }));
  console.log(JSON.stringify({ pageId, added: names, labels }, null, 2));
}

async function removeLabel(client, pageId, labelName) {
  if (!labelName) die('--label is required for --remove-label');
  logger.info(`Removing label "${labelName}" from page ${pageId}`);

  const listData = await client.request('GET', client.labelsPath(pageId));
  const found = (listData.results || []).find(l => l.name === labelName);
  if (!found) die(`Label "${labelName}" not found on page ${pageId}`);

  if (client.isV2()) {
    await client.request('DELETE', `${client.labelsPath(pageId)}/${found.id}`);
  } else {
    const qs = buildQueryString({ name: labelName, prefix: found.prefix || 'global' });
    await client.request('DELETE', `${client.labelsPath(pageId)}${qs}`);
  }
  console.log(JSON.stringify({ success: true, pageId, removedLabel: labelName }, null, 2));
}

// ─── Metadata: Properties ─────────────────────────────────────────────────────

async function listProperties(client, pageId) {
  logger.info(`Fetching properties for page: ${pageId}`);
  const data = await client.request('GET', client.propertiesPath(pageId));
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
    existing = await client.request('GET', `${client.propertiesPath(pageId)}/${key}`);
  } catch (_) {}

  if (existing) {
    const currentVersion = existing.version?.number || 1;
    logger.info(`Updating property "${key}" on page ${pageId} (version ${currentVersion} → ${currentVersion + 1})`);
    const payload = { key, value, version: { number: currentVersion + 1 } };
    const data = await client.request('PUT', `${client.propertiesPath(pageId)}/${key}`, payload);
    console.log(JSON.stringify({ pageId, key: data.key, value: data.value, version: data.version?.number }, null, 2));
  } else {
    logger.info(`Creating property "${key}" on page ${pageId}`);
    const payload = { key, value };
    const data = await client.request('POST', client.propertiesPath(pageId), payload);
    console.log(JSON.stringify({ pageId, key: data.key, value: data.value, version: data.version?.number }, null, 2));
  }
}

async function deleteProperty(client, pageId, key) {
  if (!key) die('--key is required for --delete-property');
  logger.info(`Deleting property "${key}" from page ${pageId}`);
  await client.request('DELETE', `${client.propertiesPath(pageId)}/${key}`);
  console.log(JSON.stringify({ success: true, pageId, deletedKey: key }, null, 2));
}

// ─── Metadata: Versions ───────────────────────────────────────────────────────

async function listVersions(client, pageId, limit) {
  logger.info(`Fetching versions for page: ${pageId}`);
  const qs = buildQueryString({ limit });
  const data = await client.request('GET', `${client.versionsPath(pageId)}${qs}`);
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
  const data = await client.request('GET', `${client.commentsPath(pageId)}${qs}`);
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
  const payload = client.isV2()
    ? {
        pageId,
        body: {
          representation: 'storage',
          value: body,
        },
      }
    : {
        type: 'comment',
        container: { id: pageId, type: 'page' },
        body: {
          storage: {
            representation: 'storage',
            value: body,
          },
        },
      };
  const data = await client.request('POST', client.commentsPath(pageId), payload);
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
  const endpoint = client.isV2()
    ? client.attachmentsPath(pageId)
    : client.attachmentsPath(pageId);
  const data = await client.request('GET', endpoint);
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

  // v2 API는 attachment POST 미지원 → v1 endpoint 사용
  const url = `${client.apiBaseFor('v1')}/content/${pageId}/child/attachment`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': client.authHeaderFor('v1'),
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
  const info = await client.request('GET', `/attachments/${attachmentId}`, null, 'v1');
  const filename = info.title || attachmentId;

  logger.info(`Downloading attachment: ${filename}`);
  const res = await client.downloadRaw(`/attachments/${attachmentId}/download`, 'v1');

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

  CONFLUENCE_DOMAIN       Atlassian 도메인
  CONFLUENCE_CONTEXT_PATH /wiki, /confluence 등 컨텍스트 경로
  CONFLUENCE_BASE_URL     전체 base URL 오버라이드
  CONFLUENCE_EMAIL        Cloud basic auth 계정 이메일
  CONFLUENCE_USERNAME     Server basic auth 사용자명
  CONFLUENCE_API_TOKEN    Cloud API 토큰
  CONFLUENCE_SECRET       Server PAT / 비밀번호 / bearer 토큰
  CONFLUENCE_AUTH_TYPE    basic | bearer (기본: basic)
                          basic  = 이메일/유저명 + API 토큰(PAT)을 Basic 인증으로 전송
                          bearer = CONFLUENCE_SECRET(OAuth 액세스 토큰, Server PAT 등)만
                                   Bearer 헤더로 전송 — 이메일/유저명 불필요
  CONFLUENCE_PLATFORM     cloud | server (선택 — 미지정 시 도메인으로 자동 판별:
                          *.atlassian.net → cloud, 그 외 → server)
  CONFLUENCE_API_VERSION  v1 | v2 (선택 — 미지정 시 platform 기준 자동 결정:
                          cloud → v2, server → v1)
  LOG_LEVEL               로그 레벨 (기본: info)

─── Setup ────────────────────────────────────────────────────────────────────

  1. .env.example 을 .env 로 복사
  2. base URL과 auth 타입에 맞는 변수 설정 (platform/API 버전은 보통 자동 판별됨)
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
