'use strict';

/*
 * 文献笔记生成器（单篇版 / Literature Note Single）
 * 只处理单篇文献：从 Zotero 条目生成一篇文献阅读笔记骨架，并维护 Zotero 标签。
 *
 * 本文件是源码：DEFAULT_TEMPLATE 处的占位符由 build.js 用
 * 文献笔记模板.md 的内容替换后生成 main.js。
 */

const {
  Plugin,
  Modal,
  FuzzySuggestModal,
  Notice,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} = require('obsidian');

const http = require('http');
const https = require('https');
const nodeFs = require('fs');
const nodePath = require('path');

const VERSION = '1.0.0';
const LOG_FILE = 'last-run.log';
const LOG_MAX_BYTES = 128 * 1024;

/* 运行期才知道插件 id（日志目录跟着 manifest 走，不写死）。 */
const RUNTIME = { id: 'literature-note-single', debug: false };

/* 调试日志默认关闭；打开后每一步写进 <插件目录>/last-run.log，超过 128 KB 会清空重写。 */
function logLine(app, message) {
  if (!RUNTIME.debug) return;
  try {
    const base = app && app.vault && app.vault.adapter && app.vault.adapter.basePath;
    if (!base) return;
    const configDir = (app.vault && app.vault.configDir) || '.obsidian';
    const dir = nodePath.join(base, configDir, 'plugins', RUNTIME.id);
    nodeFs.mkdirSync(dir, { recursive: true });
    const file = nodePath.join(dir, LOG_FILE);
    try {
      if (nodeFs.statSync(file).size > LOG_MAX_BYTES) {
        nodeFs.writeFileSync(file, '[log truncated at ' + new Date().toISOString() + ']\n', 'utf8');
      }
    } catch (err) {
      // 文件还不存在
    }
    const line = '[' + new Date().toISOString() + '] ' + message + '\n';
    nodeFs.appendFileSync(file, line, 'utf8');
  } catch (err) {
    // 日志失败不能影响主流程
  }
}

const DATA_MISSING = '数据缺失';
const DEFAULT_TEMPLATE = "__DEFAULT_TEMPLATE__";

const DEFAULT_SETTINGS = {
  apiBase: 'http://127.0.0.1:23119/api/users/0',
  templatePath: 'templates/文献笔记模板.md',
  titleWords: 3,
  lastFolder: '',
  useZoteroSelection: false,
  // Zotero 标签联动：新建笔记后给条目加标签，删除最后一篇笔记后移除。
  zoteroTag: '#带obs笔记',
  autoTagOnCreate: true,
  removeTagOnDelete: true,
  // 首次运行的设置向导是否已完成；调试日志默认关闭。
  setupDone: false,
  debugLog: false,
};

const ITEM_TYPE_LABELS = {
  journalArticle: '期刊论文',
  magazineArticle: '期刊论文',
  newspaperArticle: '报刊文章',
  book: '专著',
  bookSection: '专著章节',
  conferencePaper: '会议论文',
  thesis: '学位论文',
  preprint: '预印本',
  report: '报告',
  webpage: '网页',
  blogPost: '博客文章',
  manuscript: '手稿',
  document: '文档',
};

/* ------------------------------------------------------------------ */
/* 纯函数：可单独测试                                                    */
/* ------------------------------------------------------------------ */

function collapse(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function hasCJK(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

function yearOf(dateString) {
  const m = collapse(dateString).match(/\d{4}/);
  return m ? m[0] : '';
}

function mapItemType(itemType) {
  const raw = collapse(itemType);
  if (!raw) return DATA_MISSING;
  return ITEM_TYPE_LABELS[raw] || raw;
}

function formatDate(dateString) {
  const raw = collapse(dateString);
  if (!raw) return DATA_MISSING;
  const m = raw.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return raw;
  const year = m[1];
  const month = m[2] ? parseInt(m[2], 10) : 0;
  const day = m[3] ? parseInt(m[3], 10) : 0;
  if (month && day) return year + ' 年 ' + month + ' 月 ' + day + ' 日';
  if (month) return year + ' 年 ' + month + ' 月';
  return year + ' 年';
}

function authorPool(creators) {
  const list = (creators || []).filter(Boolean);
  const authors = list.filter((c) => c.creatorType === 'author');
  if (authors.length) return authors;
  return list.filter((c) => c.creatorType === 'editor');
}

function displayName(creator) {
  if (!creator) return '';
  if (creator.name) return collapse(creator.name);
  const first = collapse(creator.firstName);
  const last = collapse(creator.lastName);
  if (!last) return first;
  if (!first) return last;
  if (hasCJK(first) || hasCJK(last)) return last + first;
  return first + ' ' + last;
}

function formatAuthors(creators) {
  const pool = authorPool(creators);
  const names = pool.map(displayName).filter(Boolean);
  if (!names.length) return '';
  if (names.length > 10) return names.slice(0, 10).join('、') + ' 等';
  return names.join('、');
}

function apaAuthorName(creator) {
  if (!creator) return '';
  if (creator.name) return collapse(creator.name);
  const first = collapse(creator.firstName);
  const last = collapse(creator.lastName);
  if (!last) return first;
  if (!first) return last;
  if (hasCJK(first) || hasCJK(last)) return last + first;
  const initials = first
    .split(/[\s\-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + '.')
    .join(' ');
  return initials ? last + ', ' + initials : last;
}

function apaAuthors(creators) {
  const names = authorPool(creators).map(apaAuthorName).filter(Boolean);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length <= 20) return names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1];
  return names.slice(0, 19).join(', ') + ', … ' + names[names.length - 1];
}

function tidySentence(text) {
  return text
    .replace(/\.\s*\./g, '.')
    .replace(/\s+([.,])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function apaCitation(data) {
  const info = data || {};
  const authors = apaAuthors(info.creators);
  const title = collapse(info.title);
  if (!authors || !title) return DATA_MISSING;

  const year = yearOf(info.date) || 'n.d.';
  const doi = collapse(info.DOI);
  const doiTail = doi ? ' https://doi.org/' + doi : '';
  const type = collapse(info.itemType);
  const head = authors + ' (' + year + '). ';

  let body;
  if (type === 'journalArticle' || type === 'magazineArticle' || type === 'newspaperArticle') {
    const journal = collapse(info.publicationTitle);
    const volume = collapse(info.volume);
    const issue = collapse(info.issue);
    const pages = collapse(info.pages);
    let tail = '';
    if (journal) tail += ' _' + journal + '_';
    if (volume) tail += ', _' + volume + '_';
    if (issue) tail += '(' + issue + ')';
    if (pages) tail += ', ' + pages;
    body = head + title + '.' + tail + '.' + doiTail;
  } else if (type === 'book') {
    const publisher = collapse(info.publisher);
    body = head + '_' + title + '_.' + (publisher ? ' ' + publisher + '.' : '') + doiTail;
  } else if (type === 'thesis') {
    const university = collapse(info.university) || collapse(info.publisher);
    const thesisType = collapse(info.thesisType) || '学位论文';
    body = head + '_' + title + '_ [' + thesisType + '].' + (university ? ' ' + university + '.' : '') + doiTail;
  } else if (type === 'preprint') {
    const repo = collapse(info.repository) || collapse(info.publicationTitle);
    body = head + title + ' [Preprint].' + (repo ? ' ' + repo + '.' : '') + doiTail;
  } else if (type === 'conferencePaper') {
    const proceedings = collapse(info.proceedingsTitle) || collapse(info.conferenceName);
    body = head + title + '.' + (proceedings ? ' In _' + proceedings + '_.' : '') + doiTail;
  } else {
    const venue = collapse(info.publicationTitle);
    body = head + title + '.' + (venue ? ' _' + venue + '_.' : '') + doiTail;
  }

  return tidySentence(body);
}

function buildFileName(data, options) {
  const info = data || {};
  const opts = options || {};
  const wordCount = Math.max(1, parseInt(opts.titleWords, 10) || 3);

  const creators = (info.creators || []).filter(Boolean);
  const who =
    creators.find((c) => c.creatorType === 'author' && (c.lastName || c.name)) ||
    creators.find((c) => c.lastName || c.name);

  let surname = who ? String(who.lastName || who.name || '') : '';
  surname = surname.replace(/[\s\-·.'’]/g, '');
  if (!surname) surname = 'anon';

  const year = yearOf(info.date) || 'nd';

  const title = collapse(info.title);
  let chunk = '';
  if (title) {
    const words = title.split(/\s+/).filter(Boolean);
    chunk = words.length >= 2 ? words.slice(0, wordCount).join('') : title.slice(0, 8);
    chunk = chunk.replace(/[^\p{L}\p{N}]/gu, '');
    if (chunk) chunk = chunk.charAt(0).toUpperCase() + chunk.slice(1);
  }
  if (!chunk) chunk = 'Untitled';

  let name = surname.toLowerCase() + year + chunk;
  name = name.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, '');
  if (name.length > 90) name = name.slice(0, 90);
  return name;
}

function renderTemplate(templateText, fields) {
  const values = fields || {};
  const guarded = [];
  let text = String(templateText == null ? '' : templateText);

  // 行内代码与围栏代码块内的 {{...}} 原样保留（模板说明节里会引用占位符）。
  text = text.replace(/(```[\s\S]*?```|`[^`\n]*`)/g, function (match) {
    guarded.push(match);
    return '\u0000G' + (guarded.length - 1) + '\u0000';
  });

  text = text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (match, key) {
    const value = values[key];
    if (value === undefined || value === null || value === '') return DATA_MISSING;
    return String(value);
  });

  return text.replace(/\u0000G(\d+)\u0000/g, function (match, index) {
    return guarded[Number(index)];
  });
}

function buildFields(item, pdfLink) {
  const info = (item && item.data) || {};
  const key = (item && item.key) || '';
  const doi = collapse(info.DOI);
  const url = collapse(info.url) || (doi ? 'https://doi.org/' + doi : '');

  return {
    title: collapse(info.title) || DATA_MISSING,
    authors: formatAuthors(info.creators) || DATA_MISSING,
    date: formatDate(info.date),
    itemType: mapItemType(info.itemType),
    abstract: collapse(info.abstractNote) || DATA_MISSING,
    citation: apaCitation(info),
    zoteroLink: key
      ? '[在 Zotero 中打开](zotero://select/library/items/' + key + ')'
      : DATA_MISSING,
    url: url || DATA_MISSING,
    pdfLink: pdfLink || DATA_MISSING,
  };
}

function itemMetaLine(data) {
  const info = data || {};
  const authors = (info.creators || [])
    .filter((c) => c && c.creatorType === 'author')
    .map((c) => collapse(c.lastName) || collapse(c.name))
    .filter(Boolean);
  const parts = [];
  if (authors.length) parts.push(authors.length > 2 ? authors[0] + ' 等' : authors.join('、'));
  const year = yearOf(info.date);
  if (year) parts.push(year);
  parts.push(mapItemType(info.itemType));
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/*
 * 注意：Zotero 的本地 API 会直接断开「浏览器 User-Agent」的请求
 * （UA 以 Mozilla/ 开头，或带 Origin 头），而 Obsidian 的 requestUrl
 * 正是带这样的 UA。因此这里用 Node 的 http 模块直连，并显式给一个
 * 非浏览器 UA。
 */
const USER_AGENT = 'ObsidianLitNoteSingle/1.0 (Zotero local API)';
const DEFAULT_TIMEOUT = 8000;

const ZOTERO_API_VERSION = '3';
const ZOTERO_SERVER_ID_HEADER = 'zotero-server-id';
const ZOTERO_API_KEY_HEADER = 'zotero-api-key';
const ZOTERO_LIBRARY_VERSION_HEADER = 'zotero-library-version';
const ZOTERO_AUTHORIZE_PATH = '/local/authorize';
const WRITE_APP_NAME = 'Obsidian 文献笔记生成器';
const MAX_PENDING_TAG_OPS = 100;
const ITEM_KEY_RE = /zotero:\/\/select\/library\/items\/([A-Za-z0-9]{8})(?![A-Za-z0-9])/;

/* 带 code 的错误，便于上层区分「拒绝授权 / 冲突 / 需要重新授权」。 */
function tagError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/*
 * 通用请求：返回 { status, headers, text }，不因 4xx/5xx 抛错。
 * 写入流程需要自己读 401/403/412/428，所以不能沿用 httpGet 的「>=400 即失败」。
 */
function httpRequest(method, url, options) {
  const opts = options || {};
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return Promise.reject(new Error('API 地址不合法：' + url));
  }

  const mod = parsed.protocol === 'https:' ? https : http;
  const timeout = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT : opts.timeoutMs;
  const body = opts.body === undefined || opts.body === null ? null : String(opts.body);
  const headers = Object.assign(
    {
      'User-Agent': USER_AGENT,
      'Zotero-API-Version': ZOTERO_API_VERSION,
      Accept: 'application/json',
    },
    opts.headers || {}
  );
  if (body !== null) headers['Content-Length'] = Buffer.byteLength(body, 'utf8');

  return new Promise(function (resolve, reject) {
    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: String(method || 'GET').toUpperCase(),
        headers: headers,
      },
      function (res) {
        const chunks = [];
        res.on('data', function (chunk) {
          chunks.push(chunk);
        });
        res.on('end', function () {
          resolve({
            status: res.statusCode,
            headers: res.headers || {},
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      }
    );

    if (timeout > 0) {
      req.setTimeout(timeout, function () {
        req.destroy(new Error('连接超时（' + timeout + ' ms）'));
      });
    }
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function httpGet(url, timeoutMs) {
  const res = await httpRequest('GET', url, { timeoutMs: timeoutMs });
  if (res.status >= 400) throw new Error('Zotero 返回 HTTP ' + res.status);
  return res.text;
}

async function apiGet(apiBase, path, timeoutMs) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  const text = await httpGet(base + path, timeoutMs);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Zotero 返回内容不是 JSON');
  }
}

/* ------------------------------------------------------------------ */
/* Zotero 标签写入                                                      */
/* ------------------------------------------------------------------ */

function headerValue(headers, name) {
  if (!headers) return '';
  const wanted = String(name).toLowerCase();
  const keys = Object.keys(headers);
  for (const key of keys) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (Array.isArray(value)) return value.length ? String(value[0]) : '';
    return value === undefined || value === null ? '' : String(value);
  }
  return '';
}

/* 只认条目链接，不认 open-pdf 的附件 key。 */
function extractItemKey(text) {
  const m = String(text === null || text === undefined ? '' : text).match(ITEM_KEY_RE);
  return m ? m[1].toUpperCase() : '';
}

function tagEntries(tags) {
  const out = [];
  for (const entry of Array.isArray(tags) ? tags : []) {
    if (typeof entry === 'string') {
      const tag = collapse(entry);
      if (tag) out.push({ tag: tag });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const tag = collapse(entry.tag);
    if (!tag) continue;
    if (entry.type === undefined || entry.type === null || entry.type === '') out.push({ tag: tag });
    else out.push({ tag: tag, type: entry.type });
  }
  return out;
}

/*
 * Zotero 的 PATCH 对 tags 是整个数组替换，所以必须先读出旧标签再合并；
 * 保留旧标签的 type（颜色圆点依赖它），新标签只带 { tag }。
 */
function mergeTags(existing, add, remove) {
  const base = tagEntries(existing);
  const removeSet = new Set(
    (Array.isArray(remove) ? remove : []).map((name) => collapse(name)).filter(Boolean)
  );
  const kept = base.filter((entry) => !removeSet.has(entry.tag));
  const removed = base.filter((entry) => removeSet.has(entry.tag)).map((entry) => entry.tag);
  const seen = new Set(kept.map((entry) => entry.tag));
  const added = [];
  for (const name of Array.isArray(add) ? add : []) {
    const tag = collapse(name);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    added.push(tag);
    kept.push({ tag: tag });
  }
  return { merged: kept, added: added, removed: removed, changed: added.length > 0 || removed.length > 0 };
}

/* 服务器实例 id 在任意 GET 响应的头里；写入前必须带上它。 */
async function readServerId(apiBase, timeoutMs) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  const res = await httpRequest('GET', base + '/items?limit=1&format=json', {
    timeoutMs: timeoutMs === undefined ? DEFAULT_TIMEOUT : timeoutMs,
  });
  if (res.status >= 400) throw tagError('HTTP_ERROR', 'Zotero 返回 HTTP ' + res.status);
  return headerValue(res.headers, ZOTERO_SERVER_ID_HEADER);
}

/*
 * 授权端点是全局的：/api/local/authorize。它不在 users/<id> 或 groups/<id>
 * 下面，拼在 apiBase 后面会 404，Zotero 也就不会弹窗。
 */
function authorizeUrl(apiBase) {
  return zoteroOrigin(apiBase) + '/api/local/authorize';
}

/*
 * 向 Zotero 申请写入凭据：Zotero 会弹「Allow / Always Allow / Deny」。
 * remember=true 的 key 可以长期保存；一次性 key 用完即失效，绝不落盘。
 */
async function authorizeWrite(apiBase, serverId, options) {
  const opts = options || {};
  const headers = { 'Content-Type': 'application/json' };
  if (serverId) headers[ZOTERO_SERVER_ID_HEADER] = serverId;
  const res = await httpRequest('POST', authorizeUrl(apiBase), {
    headers: headers,
    body: JSON.stringify({ appName: opts.appName || WRITE_APP_NAME }),
    timeoutMs: opts.timeoutMs === undefined ? 180000 : opts.timeoutMs,
  });
  if (res.status === 403) throw tagError('AUTH_DENIED', '你在 Zotero 授权窗口中选择了拒绝');
  if (res.status === 429) throw tagError('AUTH_RATE_LIMITED', 'Zotero 授权请求过于频繁，请等一分钟再试');
  if (res.status >= 400) throw tagError('AUTH_FAILED', 'Zotero 授权失败（HTTP ' + res.status + '）');
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch (err) {
    json = null;
  }
  if (!json || !json.key) throw tagError('AUTH_FAILED', 'Zotero 没有返回可用的写入凭据');
  return { key: String(json.key), remember: json.remember === true };
}

async function readItemState(apiBase, key, options) {
  const opts = options || {};
  const base = String(apiBase || '').replace(/\/+$/, '');
  const res = await httpRequest('GET', base + '/items/' + encodeURIComponent(key) + '?format=json', {
    timeoutMs: opts.timeoutMs === undefined ? DEFAULT_TIMEOUT : opts.timeoutMs,
  });
  if (res.status === 404) throw tagError('ITEM_NOT_FOUND', 'Zotero 中找不到条目 ' + key);
  if (res.status >= 400) throw tagError('HTTP_ERROR', 'Zotero 返回 HTTP ' + res.status);
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch (err) {
    throw tagError('BAD_RESPONSE', 'Zotero 返回内容不是 JSON');
  }
  const record = Array.isArray(json) ? json[0] : json;
  const data = (record && record.data) || record || {};
  const version = record && Number.isInteger(record.version) ? record.version : null;
  if (version === null) throw tagError('BAD_RESPONSE', 'Zotero 没有返回条目版本号，无法安全写入');
  const observedServerId = headerValue(res.headers, ZOTERO_SERVER_ID_HEADER);
  if (opts.expectedServerId && observedServerId && opts.expectedServerId !== observedServerId) {
    throw tagError('SERVER_MISMATCH', 'Zotero 实例已变化，请重新授权');
  }
  return {
    key: collapse(record && record.key) || key,
    version: version,
    itemType: collapse(data.itemType),
    tags: tagEntries(data.tags),
    serverId: observedServerId,
  };
}

/*
 * 读-合并-写一个条目的标签。412/409 表示读完之后被别人改过，重读一次再写；
 * 仍冲突就报错，交给上层决定是否记入待办。
 */
async function updateItemTags(apiBase, key, options) {
  const opts = options || {};
  const auth = opts.auth;
  if (!auth || !auth.key) throw tagError('AUTH_REQUIRED', '尚未获得 Zotero 写入授权');

  const state = await readItemState(apiBase, key, {
    timeoutMs: opts.timeoutMs,
    expectedServerId: opts.serverId || (auth && auth.serverId),
  });
  const serverId = state.serverId || opts.serverId || (auth && auth.serverId) || '';
  const merge = mergeTags(state.tags, opts.add || [], opts.remove || []);
  if (!merge.changed) return { status: 'unchanged', libraryVersion: null, serverId: serverId };

  const base = String(apiBase || '').replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'Zotero-API-Key': auth.key,
    'If-Unmodified-Since-Version': String(state.version),
  };
  if (serverId) headers[ZOTERO_SERVER_ID_HEADER] = serverId;

  const res = await httpRequest('PATCH', base + '/items/' + encodeURIComponent(key), {
    headers: headers,
    body: JSON.stringify({ tags: merge.merged }),
    timeoutMs: opts.timeoutMs,
  });

  if (res.status === 412 || res.status === 409) {
    if (!opts.retried) {
      return updateItemTags(apiBase, key, Object.assign({}, opts, { retried: true }));
    }
    throw tagError('CONFLICT', 'Zotero 条目刚被修改，标签写入发生冲突，请稍后重试');
  }
  if (res.status === 401 || res.status === 403) {
    throw tagError('AUTH_EXPIRED', 'Zotero 写入授权已失效，需要重新授权');
  }
  if (res.status === 428) throw tagError('SERVER_ID_REQUIRED', 'Zotero 要求提供实例标识，请重新授权');
  if (res.status >= 400) throw tagError('HTTP_ERROR', 'Zotero 返回 HTTP ' + res.status);

  return {
    status: 'updated',
    libraryVersion: headerValue(res.headers, ZOTERO_LIBRARY_VERSION_HEADER),
    serverId: serverId,
  };
}

/* 从笔记内容里定位条目 key 与标题（标题失败不影响 key）。 */
function parseNoteIndexEntry(content) {
  const text = String(content === null || content === undefined ? '' : content);
  const key = extractItemKey(text);
  if (!key) return null;
  const titleMatch = text.match(/\*\*标题\*\*[:：]\s*(.+)/);
  return { key: key, title: titleMatch ? collapse(titleMatch[1]) : '' };
}

/* ------------------------------------------------------------------ */
/* Better BibTeX 的 CAYW（Cite As You Write）选择窗                     */
/* ------------------------------------------------------------------ */

/*
 * Zotero 里装了 Better BibTeX 后，GET /better-bibtex/cayw 会让 Zotero
 * 弹出它自己的条目选择窗，请求挂起到用户选完为止，然后返回结果。
 * format=json 的返回形如：
 *   [{ id, citationKey, locator, prefix, suffix, suppressAuthor,
 *      item: { itemType, title, creators, date, abstractNote, ...,
 *              uri: 'http://zotero.org/users/local/<id>/items/<KEY>', itemID } }]
 * 其中 KEY 就是 Zotero 条目 key。
 */

function zoteroOrigin(apiBase) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  try {
    return new URL(base).origin;
  } catch (err) {
    return 'http://127.0.0.1:23119';
  }
}

function caywUrl(apiBase, options) {
  const opts = options || {};
  const url = zoteroOrigin(apiBase) + '/better-bibtex/cayw?format=json';
  return opts.useSelection ? url + '&selected=true' : url;
}

function caywProbeUrl(apiBase) {
  return zoteroOrigin(apiBase) + '/better-bibtex/cayw?probe=true';
}

function parseCaywResponse(text) {
  const raw = String(text === null || text === undefined ? '' : text).trim();
  if (!raw) return [];

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return [];
  }

  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.items)) list = data.items;
  else if (data && Array.isArray(data.picks)) list = data.picks;

  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry.item && typeof entry.item === 'object' ? entry.item : entry;

    let key = collapse(item.key);
    if (!key) {
      const m = String(item.uri || entry.uri || '').match(/\/items\/([A-Za-z0-9]{8})(?:[/?#]|$)/);
      if (m) key = m[1];
    }
    if (!key && typeof entry.id === 'string') {
      const m = entry.id.match(/\/items\/([A-Za-z0-9]{8})(?:[/?#]|$)/);
      if (m) key = m[1];
    }
    if (!key) continue;

    out.push({
      key: key.toUpperCase(),
      citationKey: collapse(entry.citationKey || item.citationKey),
      data: item,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 条目选择弹窗                                                         */
/* ------------------------------------------------------------------ */

class ItemPickerModal extends Modal {
  constructor(app, apiBase, resolve) {
    super(app);
    this.apiBase = apiBase;
    this.resolve = resolve;
    this.items = [];
    this.active = 0;
    this.seq = 0;
    this.timer = null;
    this.settled = false;
  }

  onOpen() {
    const contentEl = this.contentEl;
    contentEl.createEl('h3', { text: '选择 Zotero 条目' });

    this.inputEl = contentEl.createEl('input', {
      cls: 'litnote-input',
      attr: {
        type: 'text',
        placeholder: '输入标题 / 作者 / 年份；留空列出最近修改的 25 条',
      },
    });
    this.listEl = contentEl.createDiv({ cls: 'litnote-list' });
    this.statusEl = contentEl.createDiv({ cls: 'litnote-status' });

    this.inputEl.addEventListener('input', () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.search(this.inputEl.value.trim()), 250);
    });
    this.inputEl.addEventListener('keydown', (ev) => this.onKeyDown(ev));

    this.inputEl.focus();
    this.search('');
  }

  onClose() {
    if (this.timer) clearTimeout(this.timer);
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(null);
    }
  }

  onKeyDown(ev) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (this.items.length) {
        this.active = Math.min(this.active + 1, this.items.length - 1);
        this.updateHighlight();
      }
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (this.items.length) {
        this.active = Math.max(this.active - 1, 0);
        this.updateHighlight();
      }
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const item = this.items[this.active];
      if (item) this.choose(item);
    }
  }

  async search(query) {
    const seq = ++this.seq;
    this.statusEl.setText(query ? '搜索中…' : '正在读取最近修改的条目…');

    const params = new URLSearchParams();
    params.set('limit', '25');
    params.set('format', 'json');
    if (query) {
      params.set('q', query);
      params.set('qmode', 'titleCreatorYear');
    } else {
      params.set('sort', 'dateModified');
      params.set('direction', 'desc');
    }

    try {
      const raw = await apiGet(this.apiBase, '/items/top?' + params.toString(), 8000);
      if (seq !== this.seq) return;
      this.items = (Array.isArray(raw) ? raw : []).filter(
        (it) => it && it.data && it.data.itemType !== 'note' && it.data.itemType !== 'attachment'
      );
      this.active = 0;
      this.renderList();
    } catch (err) {
      if (seq !== this.seq) return;
      this.items = [];
      this.listEl.empty();
      this.statusEl.setText('查询失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  renderList() {
    this.listEl.empty();
    if (!this.items.length) {
      this.statusEl.setText('无匹配条目');
      return;
    }
    this.statusEl.setText('共 ' + this.items.length + ' 条');
    this.items.forEach((item, index) => {
      const data = item.data || {};
      const row = this.listEl.createDiv({ cls: 'litnote-item' });
      row.dataset.index = String(index);
      row.createDiv({ cls: 'litnote-title', text: collapse(data.title) || '（无标题）' });
      row.createDiv({ cls: 'litnote-meta', text: itemMetaLine(data) });
      row.addEventListener('click', () => this.choose(item));
      row.addEventListener('mouseenter', () => {
        this.active = index;
        this.updateHighlight();
      });
    });
    this.updateHighlight();
  }

  updateHighlight() {
    const rows = this.listEl.querySelectorAll('.litnote-item');
    rows.forEach((row, index) => {
      if (index === this.active) row.addClass('is-active');
      else row.removeClass('is-active');
    });
    if (rows[this.active] && typeof rows[this.active].scrollIntoView === 'function') {
      rows[this.active].scrollIntoView({ block: 'nearest' });
    }
  }

  choose(item) {
    if (this.settled) return;
    this.settled = true;
    this.resolve(item);
    this.close();
  }
}

/* ------------------------------------------------------------------ */
/* 目录选择弹窗                                                         */
/* ------------------------------------------------------------------ */

function normalizeTypedPath(value) {
  return collapse(value)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function collectFolders(app, lastFolder) {
  let folders = [];
  try {
    const vault = app.vault;
    const list =
      typeof vault.getAllFolders === 'function'
        ? vault.getAllFolders(true)
        : vault.getAllLoadedFiles().filter((f) => f instanceof TFolder);
    folders = list.map((f) => (f.path === '/' ? '/' : f.path));
  } catch (err) {
    folders = [];
  }

  const seen = new Set();
  const unique = [];
  folders.forEach((path) => {
    if (!seen.has(path)) {
      seen.add(path);
      unique.push(path);
    }
  });

  const preferred = normalizeTypedPath(lastFolder);
  unique.sort((a, b) => {
    if (a === preferred) return -1;
    if (b === preferred) return 1;
    if (a === '/') return -1;
    if (b === '/') return 1;
    return a.localeCompare(b, 'zh-Hans-CN');
  });

  return unique.map((path) => ({ path: path, isNew: false }));
}

class FolderPickerModal extends FuzzySuggestModal {
  constructor(app, lastFolder, resolve) {
    super(app);
    this.lastFolder = lastFolder;
    this.resolve = resolve;
    this.settled = false;
    this.folders = [];
  }

  onOpen() {
    this.folders = collectFolders(this.app, this.lastFolder);
    super.onOpen();
    if (this.inputEl) {
      this.inputEl.placeholder = '选择目标目录；输入不存在的路径可新建';
    }
  }

  getItems() {
    return this.folders;
  }

  getItemText(folder) {
    if (!folder) return '';
    if (folder.isNew) return '＋ 新建文件夹：' + folder.path;
    return folder.path === '/' ? '（仓库根目录）' : folder.path;
  }

  getSuggestions(query) {
    // 基类会把每一项包装成 { match, item }，渲染与选择都读 suggestion.item；
    // 所以「新建文件夹」这一项也必须按同样的形状追加。
    const suggestions = super.getSuggestions(query);
    const typed = normalizeTypedPath(query);
    if (typed && !this.folders.some((folder) => normalizeTypedPath(folder.path) === typed)) {
      suggestions.push({ match: { score: 0, matches: [] }, item: { path: typed, isNew: true } });
    }
    return suggestions;
  }

  onChooseItem(folder) {
    if (this.settled) return;
    this.settled = true;
    this.resolve(folder.path);
  }

  onClose() {
    // Obsidian 的 SuggestModal.selectSuggestion 是「先 this.close()，再
    // onChooseSuggestion()」；若在这里立刻 resolve(null)，选择结果就丢了。
    // 所以把「取消」推迟到当前调用栈之后，让 onChooseItem 先落地。
    if (this.settled) return;
    setTimeout(() => {
      if (this.settled) return;
      this.settled = true;
      this.resolve(null);
    }, 0);
  }
}

/* ------------------------------------------------------------------ */
/* 设置向导与环境自检                                                  */
/* ------------------------------------------------------------------ */

function formatDiagnostics(rows) {
  const lines = ['文献笔记生成器（单篇版）v' + VERSION + ' 诊断 ' + new Date().toISOString()];
  for (const row of rows || []) {
    lines.push((row.ok ? '[ok] ' : '[!]  ') + row.label + (row.detail ? ' — ' + row.detail : ''));
  }
  return lines.join('\n');
}

class DiagnosticsModal extends Modal {
  constructor(app, plugin, options) {
    super(app);
    this.plugin = plugin;
    this.opts = options || {};
    this.rows = [];
    this.bodyEl = null;
    this.busy = false;
  }

  onOpen() {
    const contentEl = this.contentEl;
    contentEl.createEl('h3', {
      text: this.opts.wizard ? '设置向导' : '检查运行环境',
    });
    contentEl.createEl('p', {
      text: this.opts.wizard
        ? '逐项自检，打叉的按提示处理；其余项不影响使用。关掉后随时可以用命令「打开设置向导」回到这里。'
        : '逐项检查插件依赖，把整段诊断信息贴进 issue 能省很多来回。',
    });

    this.bodyEl = contentEl.createDiv({ cls: 'litnote-diag' });

    const buttons = contentEl.createDiv({ cls: 'litnote-diag-buttons' });
    this.makeButton(buttons, '重新检测', () => this.refresh());
    this.makeButton(buttons, '安装内置模板', async () => {
      await this.plugin.installTemplate();
      await this.refresh();
    });
    this.makeButton(buttons, '选择默认目录', () => {
      new FolderPickerModal(this.app, this.plugin.settings.lastFolder, async (value) => {
        if (!value) return;
        this.plugin.settings.lastFolder = value === '/' ? '' : value;
        await this.plugin.saveData(this.plugin.settings);
        new Notice('默认目录已设为：' + (value === '/' ? '仓库根目录' : value), 6000);
        await this.refresh();
      }).open();
    });
    this.makeButton(buttons, '复制诊断信息', () => this.copyDiagnostics());
    if (this.opts.wizard) this.makeButton(buttons, '完成', () => this.close());

    this.refresh();
  }

  makeButton(parent, label, handler) {
    const button = parent.createEl('button', { text: label });
    button.addEventListener('click', () => {
      Promise.resolve(handler()).catch((err) => {
        new Notice('操作失败：' + (err && err.message ? err.message : String(err)), 8000);
      });
    });
    return button;
  }

  async refresh() {
    if (this.busy || !this.bodyEl) return;
    this.busy = true;
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: 'litnote-status', text: '检测中…' });
    try {
      this.rows = await this.plugin.diagnosticChecks();
    } catch (err) {
      this.rows = [{ label: '自检失败', ok: false, detail: err && err.message ? err.message : String(err) }];
    }
    this.busy = false;
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    for (const row of this.rows) {
      const line = this.bodyEl.createDiv({ cls: 'litnote-diag-row' });
      line.createDiv({ cls: 'litnote-diag-mark', text: row.ok ? '✓' : '✗' });
      const text = line.createDiv({ cls: 'litnote-diag-text' });
      text.createDiv({ cls: 'litnote-diag-label', text: row.label });
      if (row.detail) text.createDiv({ cls: 'litnote-diag-detail', text: row.detail });
    }
  }

  async copyDiagnostics() {
    const text = formatDiagnostics(this.rows);
    try {
      await navigator.clipboard.writeText(text);
      new Notice('诊断信息已复制到剪贴板。', 6000);
    } catch (err) {
      new Notice('复制失败，请手动选中文本。', 6000);
    }
  }

  onClose() {
    this.contentEl.empty();
    this.bodyEl = null;
    if (this.opts.wizard) this.plugin.finishSetup();
  }
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                             */
/* ------------------------------------------------------------------ */

/* data.json 里的老版本没有标签字段；这里补齐结构，并做一份浅拷贝避免默认值被改。 */
function normalizeSettings(saved) {
  const input = saved && typeof saved === 'object' ? saved : {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, input);
  settings.noteIndex =
    input.noteIndex && typeof input.noteIndex === 'object' ? Object.assign({}, input.noteIndex) : {};
  settings.pendingTagOps = Array.isArray(input.pendingTagOps)
    ? input.pendingTagOps.filter(Boolean).slice(0, MAX_PENDING_TAG_OPS)
    : [];
  settings.zoteroAuth =
    input.zoteroAuth && input.zoteroAuth.key
      ? {
          key: String(input.zoteroAuth.key),
          serverId: collapse(input.zoteroAuth.serverId),
          appName: collapse(input.zoteroAuth.appName) || WRITE_APP_NAME,
          savedAt: collapse(input.zoteroAuth.savedAt),
        }
      : null;
  settings.zoteroTag = collapse(settings.zoteroTag) || DEFAULT_SETTINGS.zoteroTag;
  return settings;
}

class LiteratureNotePlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = normalizeSettings(saved);
    if (this.manifest && this.manifest.id) RUNTIME.id = this.manifest.id;
    RUNTIME.debug = !!this.settings.debugLog;

    if (this.app && this.app.vault && typeof this.app.vault.on === 'function') {
      this.registerEvent(
        this.app.vault.on('delete', (file) => {
          this.onNoteDeleted(file).catch((err) => {
            logLine(this.app, 'delete handler error: ' + (err && err.message ? err.message : String(err)));
          });
        })
      );
      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          this.onNoteRenamed(file, oldPath);
        })
      );
    }

    this.addRibbonIcon('notebook-pen', '为Zotero条目创建文献笔记', () => this.runCreate());

    this.addCommand({
      id: 'create-literature-note',
      name: '为Zotero条目创建文献笔记',
      callback: () => this.runCreate(),
    });

    this.addCommand({
      id: 'sync-zotero-tags',
      name: '同步待处理的 Zotero 标签',
      callback: () => {
        this.syncPendingTags().catch((err) => {
          new Notice('同步 Zotero 标签失败：' + (err && err.message ? err.message : String(err)), 10000);
        });
      },
    });

    this.addCommand({
      id: 'tag-current-note',
      name: '为当前笔记补打 Zotero 标签',
      callback: () => {
        this.tagCurrentNote().catch((err) => {
          new Notice('补打标签失败：' + (err && err.message ? err.message : String(err)), 10000);
        });
      },
    });

    this.addCommand({
      id: 'check-environment',
      name: '检查运行环境',
      callback: () => this.runDiagnostics(),
    });

    this.addCommand({
      id: 'setup-wizard',
      name: '打开设置向导',
      callback: () => this.openSetupWizard(),
    });

    this.addSettingTab(new LitNoteSettingTab(this.app, this));

    if (this.app && this.app.workspace && typeof this.app.workspace.onLayoutReady === 'function') {
      this.app.workspace.onLayoutReady(() => {
        this.refreshNoteIndex().catch((err) => {
          logLine(this.app, 'index build failed: ' + (err && err.message ? err.message : String(err)));
        });
        if (!this.settings.setupDone) this.openSetupWizard();
      });
    }
  }

  runCreate() {
    this.createNote().catch((err) => {
      console.error('[literature-note]', err);
      logLine(this.app, 'error: ' + (err && err.stack ? err.stack : String(err)));
      new Notice('创建文献笔记失败：' + (err && err.message ? err.message : String(err)), 10000);
    });
  }

  openSetupWizard() {
    new DiagnosticsModal(this.app, this, { wizard: true }).open();
  }

  runDiagnostics() {
    new DiagnosticsModal(this.app, this, {}).open();
  }

  finishSetup() {
    if (this.settings.setupDone) return;
    this.settings.setupDone = true;
    this.saveData(this.settings).catch((err) => {
      logLine(this.app, 'save setup flag failed: ' + (err && err.message ? err.message : String(err)));
    });
  }

  async diagnosticChecks() {
    const rows = [];
    const apiBase = this.apiBase();

    try {
      await apiGet(apiBase, '/items?limit=1&format=json', 5000);
      rows.push({ label: 'Zotero 本地 API', ok: true, detail: apiBase });
    } catch (err) {
      rows.push({
        label: 'Zotero 本地 API',
        ok: false,
        detail:
          ((err && err.message) || '连接失败') +
          '。请确认 Zotero 正在运行，并在「设置 → 高级」勾选「允许本机其他应用与 Zotero 通信」。',
      });
    }

    const cayw = await this.probeCayw(apiBase).catch(() => false);
    rows.push({
      label: 'Better BibTeX 的 CAYW 接口',
      ok: cayw,
      detail: cayw
        ? '可用，将从 Zotero 原生选择窗选条目'
        : '不可用，将退回内置选择器；在 Zotero 中安装并启用 Better BibTeX 后体验更好',
    });

    const templatePath = normalizePath(collapse(this.settings.templatePath) || DEFAULT_SETTINGS.templatePath);
    const templateExists = this.app.vault.getAbstractFileByPath(templatePath) instanceof TFile;
    rows.push({
      label: '模板文件',
      ok: templateExists,
      detail: templateExists ? templatePath : templatePath + ' 不存在，将使用内置模板',
    });

    const auth = this.settings.zoteroAuth;
    rows.push({
      label: 'Zotero 写入授权',
      ok: Boolean(auth),
      detail: auth
        ? '已保存（' + (auth.savedAt ? String(auth.savedAt).slice(0, 10) : '日期未知') + '）'
        : '未授权；首次加标签时 Zotero 会弹窗，选 Always Allow 可长期免弹窗',
    });

    rows.push({
      label: '标签联动',
      ok: true,
      detail:
        '标签 ' +
        this.tagName() +
        '；新建后自动加：' +
        (this.settings.autoTagOnCreate !== false ? '开' : '关') +
        '；删除后自动移除：' +
        (this.settings.removeTagOnDelete !== false ? '开' : '关'),
    });

    rows.push({
      label: '第三方插件依赖',
      ok: true,
      detail:
        '无。Templater、Dataview、Zotero Integration 等都不是必需，本插件也不调用它们' +
        this.installedPluginHint(),
    });

    return rows;
  }

  installedPluginHint() {
    const known = {
      'templater-obsidian': 'Templater',
      dataview: 'Dataview',
      'obsidian-zotero-desktop-connector': 'Zotero Integration',
    };
    let enabled = null;
    try {
      const registry = this.app && this.app.plugins;
      enabled = registry && registry.enabledPlugins ? registry.enabledPlugins : null;
    } catch (err) {
      enabled = null;
    }
    if (!enabled || typeof enabled.has !== 'function') return '';
    const present = Object.keys(known)
      .filter((id) => enabled.has(id))
      .map((id) => known[id]);
    if (!present.length) return '';
    return '（当前已启用：' + present.join('、') + '，与本插件互不依赖）';
  }

  apiBase() {
    return collapse(this.settings.apiBase) || DEFAULT_SETTINGS.apiBase;
  }

  tagName() {
    return collapse(this.settings.zoteroTag) || DEFAULT_SETTINGS.zoteroTag;
  }

  indexNote(filePath, content) {
    const parsed = parseNoteIndexEntry(content);
    if (!parsed) return null;
    const previous = this.settings.noteIndex[filePath];
    const addedAt =
      previous && previous.key === parsed.key && previous.addedAt ? previous.addedAt : new Date().toISOString();
    this.settings.noteIndex[filePath] = { key: parsed.key, title: parsed.title, addedAt: addedAt };
    return this.settings.noteIndex[filePath];
  }

  keyStillReferenced(key, exceptPath) {
    const index = this.settings.noteIndex || {};
    return Object.keys(index).some(
      (path) => path !== exceptPath && index[path] && index[path].key === key
    );
  }

  notePathForKey(key) {
    const index = this.settings.noteIndex || {};
    return Object.keys(index).find((path) => index[path] && index[path].key === key) || '';
  }

  /* 启动时扫描全部 Markdown：删除事件触发时文件已读不到，索引必须提前缓存。 */
  async refreshNoteIndex() {
    let files = [];
    try {
      if (typeof this.app.vault.getMarkdownFiles === 'function') files = this.app.vault.getMarkdownFiles();
    } catch (err) {
      files = [];
    }
    const previous = this.settings.noteIndex || {};
    const next = {};
    for (const file of files) {
      if (!file || !file.path || !/\.md$/i.test(file.path)) continue;
      try {
        const text = await this.app.vault.cachedRead(file);
        const parsed = parseNoteIndexEntry(text);
        if (!parsed) continue;
        next[file.path] = {
          key: parsed.key,
          title: parsed.title,
          addedAt:
            previous[file.path] && previous[file.path].key === parsed.key && previous[file.path].addedAt
              ? previous[file.path].addedAt
              : new Date().toISOString(),
        };
      } catch (err) {
        // 单篇读失败不影响其他笔记
      }
    }
    this.settings.noteIndex = next;
    await this.saveData(this.settings);
    logLine(this.app, 'note index: ' + Object.keys(next).length + ' notes');
  }

  onNoteRenamed(file, oldPath) {
    if (!file || !file.path || !/\.md$/i.test(file.path)) return;
    const index = this.settings.noteIndex || {};
    if (!index[oldPath]) return;
    index[file.path] = index[oldPath];
    delete index[oldPath];
    this.saveData(this.settings).catch(() => {});
  }

  async onNoteDeleted(file) {
    if (!file || !file.path || !/\.md$/i.test(file.path)) return;
    const index = this.settings.noteIndex || {};
    const entry = index[file.path];
    if (!entry) return;
    delete index[file.path];
    await this.saveData(this.settings);
    logLine(this.app, 'note deleted: ' + file.path + ' key=' + entry.key);

    if (this.settings.removeTagOnDelete === false) return;
    if (this.keyStillReferenced(entry.key, file.path)) {
      new Notice('笔记已删除；Zotero 条目仍有其他笔记引用，保留标签「' + this.tagName() + '」。', 8000);
      return;
    }
    await this.removeTagForDeletedNote(entry, file.path);
  }

  /*
   * 删除时没有持久授权就不弹授权窗（删除是瞬时动作，弹窗会打断人），
   * 先把「移除标签」记进待办，等下次新建笔记或手动同步时一起做。
   */
  async removeTagForDeletedNote(entry, notePath) {
    const auth = this.settings.zoteroAuth;
    if (!auth || !auth.key) {
      this.enqueueTagOp('remove', entry.key, entry.title, notePath);
      await this.saveData(this.settings);
      new Notice(
        '笔记已删除。未保存 Zotero 写入授权，已记下待移除标签「' + this.tagName() + '」；授权后可用命令「同步待处理的 Zotero 标签」完成。',
        12000
      );
      return;
    }
    try {
      await updateItemTags(this.apiBase(), entry.key, { auth: auth, remove: [this.tagName()], serverId: auth.serverId });
      logLine(this.app, 'tag removed key=' + entry.key);
      new Notice('笔记已删除，已从 Zotero 条目移除标签「' + this.tagName() + '」。', 8000);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logLine(this.app, 'tag remove failed key=' + entry.key + ': ' + message);
      if (err && err.code === 'ITEM_NOT_FOUND') {
        new Notice('笔记已删除；Zotero 中已找不到该条目，无需移除标签。', 8000);
        return;
      }
      if (err && (err.code === 'AUTH_EXPIRED' || err.code === 'AUTH_REQUIRED')) {
        this.settings.zoteroAuth = null;
      }
      this.enqueueTagOp('remove', entry.key, entry.title, notePath);
      await this.saveData(this.settings);
      new Notice('笔记已删除，但标签「' + this.tagName() + '」暂未移除（' + message + '）。已记入待办。', 12000);
    }
  }

  enqueueTagOp(op, key, title, notePath) {
    if (!Array.isArray(this.settings.pendingTagOps)) this.settings.pendingTagOps = [];
    const same = this.settings.pendingTagOps.find(
      (entry) => entry && entry.op === op && entry.key === key && (entry.notePath || '') === (notePath || '')
    );
    if (same) {
      same.at = new Date().toISOString();
      if (title) same.title = title;
      return;
    }
    this.settings.pendingTagOps.push({
      op: op,
      key: key,
      title: title || '',
      notePath: notePath || '',
      at: new Date().toISOString(),
      attempts: 0,
    });
    while (this.settings.pendingTagOps.length > MAX_PENDING_TAG_OPS) this.settings.pendingTagOps.shift();
  }

  async ensureAuthorization(interactive) {
    if (this.settings.zoteroAuth && this.settings.zoteroAuth.key) return this.settings.zoteroAuth;
    if (!interactive) throw tagError('AUTH_REQUIRED', '尚未获得 Zotero 写入授权');

    const apiBase = this.apiBase();
    const serverId = await readServerId(apiBase, 8000);
    new Notice('请在 Zotero 弹出的窗口中允许本插件写入标签…', 0);
    const granted = await authorizeWrite(apiBase, serverId, { appName: WRITE_APP_NAME });
    const auth = {
      key: granted.key,
      serverId: serverId,
      appName: WRITE_APP_NAME,
      savedAt: new Date().toISOString(),
    };
    // 一次性 key 不落盘：就算保存了，下次也必然 401。
    this.settings.zoteroAuth = granted.remember ? auth : null;
    await this.saveData(this.settings);
    logLine(this.app, 'authorize remember=' + granted.remember);
    return auth;
  }

  async tagNote(key, title, notePath, options) {
    const opts = options || {};
    const tag = this.tagName();
    try {
      const auth = await this.ensureAuthorization(opts.interactive !== false);
      const result = await updateItemTags(this.apiBase(), key, {
        auth: auth,
        add: [tag],
        serverId: auth.serverId,
      });
      logLine(this.app, 'tag add key=' + key + ' result=' + result.status);
      if (result.status === 'unchanged') new Notice('Zotero 条目已有标签「' + tag + '」。', 6000);
      return result.status;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logLine(this.app, 'tag add failed key=' + key + ': ' + message);
      if (err && err.code === 'AUTH_DENIED') {
        new Notice('已跳过 Zotero 标签：你在授权窗口中选择了拒绝。', 10000);
        return 'denied';
      }
      if (err && err.code === 'AUTH_RATE_LIMITED') {
        this.enqueueTagOp('add', key, title, notePath);
        await this.saveData(this.settings);
        new Notice('Zotero 授权弹窗太频繁，已暂停。请等一分钟再用命令「为当前笔记补打 Zotero 标签」。', 12000);
        return 'queued';
      }
      if (err && (err.code === 'AUTH_EXPIRED' || err.code === 'AUTH_REQUIRED')) {
        this.settings.zoteroAuth = null;
      }
      this.enqueueTagOp('add', key, title, notePath);
      await this.saveData(this.settings);
      new Notice(
        '笔记已建立，但标签「' + tag + '」暂未写入 Zotero（' + message + '）。已记入待办，稍后可用命令「同步待处理的 Zotero 标签」重试。',
        12000
      );
      return 'queued';
    }
  }

  async syncPendingTags() {
    if (!this.settings.pendingTagOps.length) {
      new Notice('没有待处理的 Zotero 标签操作。', 6000);
      return { done: 0, left: 0 };
    }
    try {
      await this.ensureAuthorization(true);
    } catch (err) {
      new Notice('同步暂停：' + (err && err.message ? err.message : String(err)), 10000);
      return { done: 0, left: this.settings.pendingTagOps.length };
    }

    const tag = this.tagName();
    let done = 0;
    for (const op of this.settings.pendingTagOps.slice()) {
      if (!op || !op.key) {
        this.settings.pendingTagOps = this.settings.pendingTagOps.filter((entry) => entry !== op);
        continue;
      }
      if (op.op === 'add' && !this.notePathForKey(op.key)) {
        this.settings.pendingTagOps = this.settings.pendingTagOps.filter((entry) => entry !== op);
        continue;
      }
      if (op.op === 'remove' && this.keyStillReferenced(op.key, op.notePath)) {
        this.settings.pendingTagOps = this.settings.pendingTagOps.filter((entry) => entry !== op);
        continue;
      }
      try {
        await updateItemTags(this.apiBase(), op.key, {
          auth: this.settings.zoteroAuth,
          add: op.op === 'add' ? [tag] : [],
          remove: op.op === 'remove' ? [tag] : [],
          serverId: this.settings.zoteroAuth && this.settings.zoteroAuth.serverId,
        });
        done += 1;
        this.settings.pendingTagOps = this.settings.pendingTagOps.filter((entry) => entry !== op);
        await this.saveData(this.settings);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        logLine(this.app, 'sync tag op failed ' + op.op + ' ' + op.key + ': ' + message);
        if (err && (err.code === 'AUTH_EXPIRED' || err.code === 'AUTH_REQUIRED')) {
          this.settings.zoteroAuth = null;
          await this.saveData(this.settings);
          break;
        }
        if (err && err.code === 'ITEM_NOT_FOUND') {
          this.settings.pendingTagOps = this.settings.pendingTagOps.filter((entry) => entry !== op);
          await this.saveData(this.settings);
          continue;
        }
        op.attempts = (op.attempts || 0) + 1;
        op.lastError = message;
        await this.saveData(this.settings);
      }
    }
    new Notice('Zotero 标签同步：完成 ' + done + ' 项，剩余 ' + this.settings.pendingTagOps.length + ' 项。', 8000);
    return { done: done, left: this.settings.pendingTagOps.length };
  }

  async tagCurrentNote() {
    const file =
      this.app && this.app.workspace && typeof this.app.workspace.getActiveFile === 'function'
        ? this.app.workspace.getActiveFile()
        : null;
    if (!file) {
      new Notice('请先打开一篇文献笔记。', 6000);
      return;
    }
    let text = '';
    try {
      text = await this.app.vault.cachedRead(file);
    } catch (err) {
      text = '';
    }
    const parsed = parseNoteIndexEntry(text);
    if (!parsed) {
      new Notice('当前笔记里找不到 zotero://select/library/items/<KEY> 链接，无法定位条目。', 10000);
      return;
    }
    this.indexNote(file.path, text);
    await this.saveData(this.settings);
    await this.tagNote(parsed.key, parsed.title, file.path, { interactive: true });
  }

  async createNote() {
    const apiBase = collapse(this.settings.apiBase) || DEFAULT_SETTINGS.apiBase;
    logLine(this.app, '=== v' + VERSION + ' run start, apiBase=' + apiBase + ', useSelection=' + !!this.settings.useZoteroSelection);

    try {
      await apiGet(apiBase, '/items?limit=1&format=json', 8000);
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      logLine(this.app, 'abort: 连接 Zotero 失败 ' + detail);
      new Notice(
        '无法连接 Zotero 本地 API（' + detail + '）。请确认 Zotero 正在运行，并在「设置 → 高级」中勾选「允许本机其他应用与 Zotero 通信」。',
        12000
      );
      return;
    }
    logLine(this.app, 'connected');

    const item = await this.pickItem(apiBase);
    if (!item || !item.key) {
      logLine(this.app, 'abort: 未取得条目');
      new Notice('已取消：没有取得 Zotero 条目，未创建笔记。', 6000);
      return;
    }
    logLine(
      this.app,
      'picked key=' + item.key + ', title=' + collapse(item.data && item.data.title).slice(0, 80)
    );

    const pdfLink = await this.findPdfLink(apiBase, item.key);
    logLine(this.app, 'pdfLink=' + (pdfLink || '（无附件）'));

    const folder = await new Promise((resolve) => {
      new FolderPickerModal(this.app, this.settings.lastFolder, resolve).open();
    });
    if (!folder) {
      logLine(this.app, 'abort: 未选择目录');
      new Notice('已取消：没有选择目录，未创建笔记。', 6000);
      return;
    }
    logLine(this.app, 'folder=' + folder);

    const template = await this.readTemplate();
    const content = renderTemplate(template, buildFields(item, pdfLink));

    const stem = buildFileName(item.data, { titleWords: this.settings.titleWords });
    const dir = folder === '/' ? '' : collapse(folder).replace(/^\/+|\/+$/g, '');
    const filePath = normalizePath(dir ? dir + '/' + stem + '.md' : stem + '.md');
    logLine(this.app, 'template=' + (template || '').length + ' chars, filePath=' + filePath);

    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      logLine(this.app, 'existing file, open only: ' + filePath);
      new Notice('同名笔记已存在：' + stem + '.md（未覆盖，已为你打开）', 8000);
      await this.app.workspace.getLeaf(true).openFile(existing);
      return;
    }

    await this.ensureFolder(dir);
    const file = await this.app.vault.create(filePath, content);
    const createdPath = (file && file.path) || filePath;
    logLine(this.app, 'created: ' + createdPath);

    this.settings.lastFolder = dir || '/';
    this.indexNote(createdPath, content);
    await this.saveData(this.settings);

    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice('已创建文献笔记：' + stem + '.md', 6000);

    if (this.settings.autoTagOnCreate !== false) {
      await this.tagNote(item.key, collapse(item.data && item.data.title), createdPath, { interactive: true });
    }
  }

  async pickItem(apiBase) {
    if (await this.probeCayw(apiBase)) {
      logLine(this.app, 'using CAYW picker');
      return this.pickFromZotero(apiBase);
    }

    logLine(this.app, 'fallback to built-in item picker');
    new Notice(
      '未检测到 Better BibTeX 的 CAYW 接口，已临时改用内置选择器。在 Zotero 中安装并启用 Better BibTeX 后，即可使用 Zotero 原生的选择窗。',
      12000
    );
    const item = await new Promise((resolve) => {
      new ItemPickerModal(this.app, apiBase, resolve).open();
    });
    if (!item || !item.key) return null;
    return { key: item.key, data: item.data };
  }

  async probeCayw(apiBase) {
    try {
      const text = await httpGet(caywProbeUrl(apiBase), 5000);
      const ready = String(text).trim() === 'ready';
      logLine(this.app, 'cayw probe=' + ready + ' body=' + JSON.stringify(String(text).trim().slice(0, 40)));
      return ready;
    } catch (err) {
      logLine(this.app, 'cayw probe failed: ' + (err && err.message ? err.message : String(err)));
      return false;
    }
  }

  async pickFromZotero(apiBase) {
    const url = caywUrl(apiBase, { useSelection: !!this.settings.useZoteroSelection });
    logLine(this.app, 'cayw request: ' + url);

    const notice = new Notice('请在 Zotero 的选择窗中选中条目…（Esc 取消）', 0);
    let text;
    try {
      text = await httpGet(url, 300000);
    } catch (err) {
      logLine(this.app, 'cayw error: ' + (err && err.message ? err.message : String(err)));
      if (/超时/.test(String(err && err.message))) throw new Error('等待 Zotero 选择超时');
      throw err;
    } finally {
      notice.hide();
      try {
        window.focus();
      } catch (err) {
        // 非浏览器环境，忽略
      }
    }

    logLine(this.app, 'cayw body (' + String(text || '').length + ' chars): ' + String(text || '').slice(0, 400));

    const picks = parseCaywResponse(text);
    logLine(this.app, 'cayw picks=' + picks.length + ' keys=' + picks.map((p) => p.key).join(','));
    if (!picks.length) {
      if (String(text || '').trim()) {
        throw new Error('无法解析 Zotero 返回的选择结果');
      }
      return null; // 用户取消
    }
    if (picks.length > 1) {
      new Notice('已在 Zotero 中选择 ' + picks.length + ' 项，本次使用第一条。', 6000);
    }
    return picks[0];
  }

  async findPdfLink(apiBase, key) {
    try {
      const children = await apiGet(
        apiBase,
        '/items/' + encodeURIComponent(key) + '/children?format=json',
        5000
      );
      const pdf = (Array.isArray(children) ? children : []).find(
        (child) =>
          child &&
          child.data &&
          child.data.itemType === 'attachment' &&
          collapse(child.data.contentType).toLowerCase() === 'application/pdf'
      );
      if (pdf && pdf.key) return '[打开 PDF](zotero://open-pdf/library/items/' + pdf.key + ')';
    } catch (err) {
      // 尽力而为：查不到就写「数据缺失」
    }
    return '';
  }

  async readTemplate() {
    const path = normalizePath(collapse(this.settings.templatePath) || DEFAULT_SETTINGS.templatePath);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        const text = await this.app.vault.cachedRead(file);
        if (collapse(text)) return text;
      } catch (err) {
        // 落到内置模板
      }
    }
    new Notice('未找到模板「' + path + '」，已改用内置模板。', 8000);
    return DEFAULT_TEMPLATE;
  }

  async installTemplate() {
    const path = normalizePath(collapse(this.settings.templatePath) || DEFAULT_SETTINGS.templatePath);
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice('模板已存在：' + path + '（未覆盖）', 6000);
      return false;
    }
    const dir = path.split('/').slice(0, -1).join('/');
    if (dir) await this.ensureFolder(dir);
    await this.app.vault.create(path, DEFAULT_TEMPLATE);
    new Notice('已把内置模板写入 ' + path + '，之后可以自由编辑。', 8000);
    return true;
  }

  async ensureFolder(dir) {
    if (!dir) return;
    const segments = dir.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current = current ? current + '/' + segment : segment;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch (err) {
        if (!this.app.vault.getAbstractFileByPath(current)) throw err;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 设置页                                                               */
/* ------------------------------------------------------------------ */

class LitNoteSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const containerEl = this.containerEl;
    containerEl.empty();
    new Setting(containerEl).setName('文献笔记生成器（单篇版）').setHeading();
    containerEl.createEl('p', {
      text: '命令「为Zotero条目创建文献笔记」会读取 Zotero 本地 API，并在每次运行时询问目标目录。',
    });

    new Setting(containerEl)
      .setName('还没配好？')
      .setDesc('首次使用建议先走一遍向导；之后随时可以回来复查 Zotero、Better BibTeX、模板与授权状态。')
      .addButton((button) =>
        button.setButtonText('打开设置向导').onClick(() => this.plugin.openSetupWizard())
      )
      .addButton((button) =>
        button.setButtonText('检查运行环境').onClick(() => this.plugin.runDiagnostics())
      )
      .addButton((button) =>
        button.setButtonText('安装内置模板').onClick(async () => {
          try {
            await this.plugin.installTemplate();
            this.display();
          } catch (err) {
            new Notice('写入模板失败：' + (err && err.message ? err.message : String(err)), 10000);
          }
        })
      );

    new Setting(containerEl)
      .setName('Zotero 本地 API 地址')
      .setDesc('默认指向个人库：http://127.0.0.1:23119/api/users/0')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.apiBase)
          .setValue(this.plugin.settings.apiBase)
          .onChange(async (value) => {
            this.plugin.settings.apiBase = collapse(value) || DEFAULT_SETTINGS.apiBase;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName('模板文件')
      .setDesc('相对仓库根的路径；每次运行都会重新读取，改完保存即生效。')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.templatePath)
          .setValue(this.plugin.settings.templatePath)
          .onChange(async (value) => {
            this.plugin.settings.templatePath = collapse(value) || DEFAULT_SETTINGS.templatePath;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName('文件名取标题前几个词')
      .setDesc('默认 3。生成规则：作者姓小写 + 年份 + 标题词拼接，如 mallory2026Formatsofrepresentation。')
      .addText((text) =>
        text
          .setPlaceholder('3')
          .setValue(String(this.plugin.settings.titleWords))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            this.plugin.settings.titleWords = parsed > 0 && parsed <= 8 ? parsed : 3;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName('直接使用 Zotero 中已选中的条目')
      .setDesc('开启后不弹选择窗，直接把 Zotero 里当前选中的条目作为目标；关闭时由 Zotero 弹出选择窗。')
      .addToggle((toggle) =>
        toggle.setValue(!!this.plugin.settings.useZoteroSelection).onChange(async (value) => {
          this.plugin.settings.useZoteroSelection = Boolean(value);
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl).setName('Zotero 标签联动').setHeading();
    containerEl.createEl('p', {
      text: '新建文献笔记后给对应 Zotero 条目加标签；删除最后一篇引用该条目的笔记后移除标签。',
    });

    new Setting(containerEl)
      .setName('标签名')
      .setDesc('默认「#带obs笔记」。新建笔记成功后加到条目上，删除时按同名标签移除。')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.zoteroTag)
          .setValue(this.plugin.settings.zoteroTag)
          .onChange(async (value) => {
            this.plugin.settings.zoteroTag = collapse(value) || DEFAULT_SETTINGS.zoteroTag;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName('新建笔记后自动加标签')
      .setDesc('关闭后只建笔记、不碰 Zotero；可用命令「为当前笔记补打 Zotero 标签」手动补。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoTagOnCreate !== false).onChange(async (value) => {
          this.plugin.settings.autoTagOnCreate = Boolean(value);
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl)
      .setName('删除笔记后自动移除标签')
      .setDesc('仅当没有其他笔记引用同一条目时才移除；移除失败会记入待办，不丢数据。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.removeTagOnDelete !== false).onChange(async (value) => {
          this.plugin.settings.removeTagOnDelete = Boolean(value);
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    const auth = this.plugin.settings.zoteroAuth;
    new Setting(containerEl)
      .setName('Zotero 写入授权')
      .setDesc(
        auth
          ? '已保存授权（' +
              (auth.savedAt ? String(auth.savedAt).slice(0, 10) : '日期未知') +
              '）。凭据保存在本插件的 data.json，可随时解除。'
          : '尚未保存授权。首次加/删标签时 Zotero 会弹窗；选「Always Allow」可长期免弹窗，选「Allow」只用一次。'
      )
      .addButton((button) =>
        button.setButtonText('立即授权').onClick(async () => {
          try {
            await this.plugin.ensureAuthorization(true);
            new Notice('Zotero 写入授权已就绪。', 6000);
          } catch (err) {
            new Notice('授权失败：' + (err && err.message ? err.message : String(err)), 10000);
          }
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText('解除授权').onClick(async () => {
          this.plugin.settings.zoteroAuth = null;
          await this.plugin.saveData(this.plugin.settings);
          new Notice('已解除 Zotero 写入授权。', 6000);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('调试日志')
      .setDesc('开启后把每一步写入插件目录下的 last-run.log（超过 128 KB 自动清空）。排查「点了没反应」时用，平时关着。')
      .addToggle((toggle) =>
        toggle.setValue(!!this.plugin.settings.debugLog).onChange(async (value) => {
          this.plugin.settings.debugLog = Boolean(value);
          RUNTIME.debug = Boolean(value);
          await this.plugin.saveData(this.plugin.settings);
        })
      );
  }
}

module.exports = LiteratureNotePlugin;
LiteratureNotePlugin.__test__ = {
  DATA_MISSING,
  DEFAULT_TEMPLATE,
  DEFAULT_SETTINGS,
  VERSION,
  collapse,
  formatDate,
  formatAuthors,
  mapItemType,
  apaCitation,
  apaAuthors,
  buildFileName,
  renderTemplate,
  buildFields,
  tidySentence,
  normalizeTypedPath,
  collectFolders,
  FolderPickerModal,
  formatDiagnostics,
  caywUrl,
  caywProbeUrl,
  parseCaywResponse,
  apiGet,
  httpGet,
  httpRequest,
  USER_AGENT,
  // 标签联动
  normalizeSettings,
  extractItemKey,
  tagEntries,
  mergeTags,
  parseNoteIndexEntry,
  headerValue,
  readServerId,
  authorizeWrite,
  readItemState,
  updateItemTags,
};
