'use strict';

/*
 * 离线测试：不需要 Obsidian，也不需要 Zotero 在运行。
 * 用法：node test/run.js
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

/* ---------------- 打桩 obsidian 模块 ---------------- */

class StubModal {
  constructor(app) {
    this.app = app;
    this.contentEl = makeEl();
    this.modalEl = makeEl();
    this.titleEl = makeEl();
  }
  open() {}
  close() {}
}

class StubFuzzySuggestModal extends StubModal {
  setPlaceholder() {}
  onOpen() {}
  // 模拟 Obsidian 的真实顺序：selectSuggestion 先 close()，再 onChooseSuggestion()
  open() {
    this.onOpen();
    const items = typeof this.getItems === 'function' ? this.getItems() : [];
    if (this.onClose) this.onClose();
    if (items.length && typeof this.onChooseItem === 'function') this.onChooseItem(items[0]);
  }
}

class StubPlugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  addCommand() {}
  addSettingTab() {}
  addRibbonIcon() {
    return { setTooltip() { return this; } };
  }
  register() {}
  registerEvent() {}
  async loadData() {
    return null;
  }
  async saveData() {}
}

class StubPluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeEl();
  }
}

class StubSetting {
  constructor() {}
  setName() {
    return this;
  }
  setHeading() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText() {
    return this;
  }
  addToggle(cb) {
    if (typeof cb === 'function') cb(makeToggle());
    return this;
  }
  addButton(cb) {
    if (typeof cb === 'function') cb(makeButton());
    return this;
  }
}

function makeToggle() {
  return {
    value: undefined,
    setValue(value) {
      this.value = value;
      return this;
    },
    onChange(handler) {
      this.handler = handler;
      return this;
    },
  };
}

function makeButton() {
  return {
    text: '',
    handler: null,
    setButtonText(text) {
      this.text = String(text);
      return this;
    },
    setIcon() {
      return this;
    },
    setCta() {
      return this;
    },
    onClick(handler) {
      this.handler = handler;
      return this;
    },
  };
}

class StubNotice {
  constructor(message) {
    this.message = String(message);
    StubNotice.messages.push(this.message);
  }
  hide() {
    this.hidden = true;
  }
  setMessage(message) {
    this.message = String(message);
  }
}
StubNotice.messages = [];

class TFile {}
class TFolder {}

function makeEl() {
  const el = {
    children: [],
    empty() {
      this.children.length = 0;
    },
    createEl(tag, options) {
      const child = makeEl();
      child.tagName = String(tag || 'div').toUpperCase();
      child.text = options && options.text ? String(options.text) : '';
      child.value = child.text;
      this.children.push(child);
      return child;
    },
    createDiv() {
      const child = makeEl();
      this.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    listeners: {},
    setText(text) {
      this.text = String(text);
    },
  };
  return el;
}

const obsidianStub = {
  Plugin: StubPlugin,
  Modal: StubModal,
  FuzzySuggestModal: StubFuzzySuggestModal,
  Notice: StubNotice,
  PluginSettingTab: StubPluginSettingTab,
  Setting: StubSetting,
  TFile: TFile,
  TFolder: TFolder,
  normalizePath(p) {
    return String(p)
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^\/+|\/+$/g, '');
  },
  requestUrl(opts) {
    if (typeof obsidianStub.__request === 'function') return obsidianStub.__request(opts);
    throw new Error('测试环境不应发起网络请求');
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

/* ---------------- 断言助手 ---------------- */

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failures.push({ label: label, actual: a, expected: e });
  }
}

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

/* ---------------- 载入被测代码 ---------------- */

const mainPath = path.join(ROOT, 'main.js');
if (!fs.existsSync(mainPath)) {
  console.error('找不到 main.js，请先运行 node build.js');
  process.exit(1);
}

const Plugin = require(mainPath);
const T = Plugin.__test__;
const templateFile = path.join(ROOT, '文献笔记模板.md');
const templateText = fs.readFileSync(templateFile, 'utf8');

/* ---------------- 样例条目 ---------------- */

const mallory = {
  key: 'ABCD1234',
  data: {
    itemType: 'journalArticle',
    title: 'Formats of representation in large language models',
    creators: [{ creatorType: 'author', firstName: 'Fintan', lastName: 'Mallory' }],
    date: '2026-03-05',
    publicationTitle: 'Philosophy and the Mind Sciences',
    volume: '7',
    issue: '1',
    abstractNote: 'This paper argues that\nrepresentational formats matter.',
    url: '',
    DOI: '',
  },
};

/* ---------------- 文件名 ---------------- */

check(
  '文件名：mallory 样例',
  T.buildFileName(mallory.data, { titleWords: 3 }),
  'mallory2026Formatsofrepresentation'
);

check(
  '文件名：中文标题取前 8 字',
  T.buildFileName(
    {
      title: '论人工智能的表征问题研究',
      creators: [{ creatorType: 'author', lastName: '王', firstName: '小明' }],
      date: '2024',
    },
    { titleWords: 3 }
  ),
  '王2024论人工智能的表征'
);

check(
  '文件名：无作者无年份',
  T.buildFileName({ title: 'Some Untitled Draft' }, { titleWords: 3 }),
  'anonndSomeUntitledDraft'
);

check(
  '文件名：剔除非法字符',
  T.buildFileName(
    {
      title: 'A/B: testing?',
      creators: [{ creatorType: 'author', lastName: 'Doe' }],
      date: '2020',
    },
    { titleWords: 3 }
  ),
  'doe2020ABtesting'
);

/* ---------------- 日期 ---------------- */

check('日期：年月日', T.formatDate('2026-03-05'), '2026 年 3 月 5 日');
check('日期：年月', T.formatDate('2026-03'), '2026 年 3 月');
check('日期：仅年', T.formatDate('2026'), '2026 年');
check('日期：缺失', T.formatDate(''), '数据缺失');

/* ---------------- 类型 ---------------- */

check('类型：期刊论文', T.mapItemType('journalArticle'), '期刊论文');
check('类型：专著', T.mapItemType('book'), '专著');
check('类型：未知原样', T.mapItemType('dataset'), 'dataset');
check('类型：缺失', T.mapItemType(''), '数据缺失');

/* ---------------- APA ---------------- */

check(
  'APA：期刊论文',
  T.apaCitation(mallory.data),
  'Mallory, F. (2026). Formats of representation in large language models. _Philosophy and the Mind Sciences_, _7_(1).'
);

check(
  'APA：专著',
  T.apaCitation({
    itemType: 'book',
    title: 'The Book',
    creators: [{ creatorType: 'author', firstName: 'John', lastName: 'Smith' }],
    date: '2019',
    publisher: 'MIT Press',
  }),
  'Smith, J. (2019). _The Book_. MIT Press.'
);

check(
  'APA：预印本',
  T.apaCitation({
    itemType: 'preprint',
    title: 'A Preprint',
    creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }],
    date: '2023',
    repository: 'arXiv',
  }),
  'Doe, J. (2023). A Preprint [Preprint]. arXiv.'
);

check(
  'APA：两位作者用 & 连接',
  T.apaAuthors([
    { creatorType: 'author', firstName: 'A', lastName: 'One' },
    { creatorType: 'author', firstName: 'B', lastName: 'Two' },
  ]),
  'One, A., & Two, B.'
);

check(
  'APA：缺作者返回数据缺失',
  T.apaCitation({ title: 'No Author', itemType: 'book' }),
  '数据缺失'
);

check(
  '作者展示：名 姓，以顿号分隔',
  T.formatAuthors([
    { creatorType: 'author', firstName: 'Fintan', lastName: 'Mallory' },
    { creatorType: 'author', firstName: 'Ann', lastName: 'Lee' },
  ]),
  'Fintan Mallory、Ann Lee'
);

/* ---------------- 字段组装 ---------------- */

const fields = T.buildFields(mallory, '');
check('字段：标题', fields.title, mallory.data.title);
check('字段：作者', fields.authors, 'Fintan Mallory');
check('字段：日期', fields.date, '2026 年 3 月 5 日');
check('字段：类型', fields.itemType, '期刊论文');
check('字段：摘要折叠换行', fields.abstract, 'This paper argues that representational formats matter.');
check('字段：无 URL 无 DOI', fields.url, '数据缺失');
check('字段：无 PDF', fields.pdfLink, '数据缺失');
check(
  '字段：Zotero 链接',
  fields.zoteroLink,
  '[在 Zotero 中打开](zotero://select/library/items/ABCD1234)'
);

const withPdf = T.buildFields(mallory, '[打开 PDF](zotero://open-pdf/library/items/PDF999)');
check(
  '字段：有 PDF',
  withPdf.pdfLink,
  '[打开 PDF](zotero://open-pdf/library/items/PDF999)'
);

/* ---------------- 模板 ---------------- */

check('模板：内置模板与模板文件完全一致', T.DEFAULT_TEMPLATE === templateText, true);
const rendered = T.renderTemplate(templateText, fields);

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

checkTrue('渲染：正文不再残留 {{ 占位符', stripCode(rendered).indexOf('{{') === -1);
checkTrue('渲染：行内代码中的占位符被原样保留', rendered.indexOf('`{{title}}`') !== -1);
checkTrue('渲染：新增字段示例也被保留', rendered.indexOf('{{新字段}}') !== -1);
checkTrue('渲染：标题已填入', rendered.indexOf('- **标题**：Formats of representation') !== -1);
checkTrue('渲染：Zotero 链接已填入', rendered.indexOf('zotero://select/library/items/ABCD1234') !== -1);

function countStandaloneLine(text, prefix) {
  const matches = text.match(new RegExp('^' + prefix + '.*$', 'gm'));
  return matches ? matches.length : 0;
}

check('渲染：【待大语言模型生成】独立行 8 处', countStandaloneLine(rendered, '【待大语言模型生成'), 8);
check('渲染：【待手动填充】独立行 2 处', countStandaloneLine(rendered, '【待手动填充】'), 2);

const headings = rendered.match(/^# .+$/gm) || [];
check('渲染：一级标题数量', headings.length, 6);
check('渲染：一级标题顺序', headings, [
  '# 文献信息',
  '# 直觉感悟与扩展讨论',
  '# 个别要点详述',
  '# 全文详细解析',
  '# 索引速查项',
  '# 附：如何更新本模板',
]);

check('渲染：二级标题数量（索引速查项下 7 个）', (rendered.match(/^## .+$/gm) || []).length, 7);

/* ---------------- CAYW：Zotero 原生选择窗 ---------------- */

let caywSample = JSON.stringify([
  {
    id: 1234,
    citationKey: 'block2023BorderSeeingThinking',
    locator: '',
    prefix: '',
    suffix: '',
    suppressAuthor: false,
    item: {
      itemType: 'book',
      title: 'The Border Between Seeing and Thinking',
      creators: [{ creatorType: 'author', firstName: 'Ned', lastName: 'Block' }],
      date: '2023',
      publisher: 'OUP Usa',
      uri: 'http://zotero.org/users/local/8F5dulWe/items/AYVXCS2Y',
      itemID: 1234,
    },
  },
]);

const picks = T.parseCaywResponse(caywSample);
check('CAYW：解析出 1 条', picks.length, 1);
check('CAYW：条目 key', picks[0] && picks[0].key, 'AYVXCS2Y');
check('CAYW：citationKey', picks[0] && picks[0].citationKey, 'block2023BorderSeeingThinking');
check('CAYW：标题', picks[0] && picks[0].data.title, 'The Border Between Seeing and Thinking');
check('CAYW：空响应视为取消', T.parseCaywResponse('').length, 0);
check('CAYW：纯空白视为取消', T.parseCaywResponse('  \n ').length, 0);
check('CAYW：乱码视为无结果', T.parseCaywResponse('<html>nope</html>').length, 0);
check(
  'CAYW：无 key 的项被丢弃',
  T.parseCaywResponse(JSON.stringify([{ item: { title: 'no key' } }])).length,
  0
);
check(
  'CAYW：{items:[…]} 包装',
  T.parseCaywResponse(JSON.stringify({ items: JSON.parse(caywSample) })).length,
  1
);
check(
  'CAYW：key 统一大写',
  T.parseCaywResponse(JSON.stringify([{ item: { title: 'x', uri: 'http://zotero.org/users/0/items/abcd1234' } }]))[0]
    .key,
  'ABCD1234'
);

check(
  'CAYW：默认 URL',
  T.caywUrl('http://127.0.0.1:23119/api/users/0'),
  'http://127.0.0.1:23119/better-bibtex/cayw?format=json'
);
check(
  'CAYW：选中模式 URL',
  T.caywUrl('http://127.0.0.1:23119/api/users/0', { useSelection: true }),
  'http://127.0.0.1:23119/better-bibtex/cayw?format=json&selected=true'
);
check(
  'CAYW：probe URL',
  T.caywProbeUrl('http://127.0.0.1:23119/api/users/0'),
  'http://127.0.0.1:23119/better-bibtex/cayw?probe=true'
);

/* ---------------- 目录路径与目录列表 ---------------- */

check('路径：去掉首尾与重复斜杠', T.normalizeTypedPath(' /AI 表征//文献阅读笔记/ '), 'AI 表征/文献阅读笔记');
check('路径：反斜杠转正斜杠', T.normalizeTypedPath('AI 表征\\文献阅读笔记'), 'AI 表征/文献阅读笔记');

function stubFolder(path) {
  const folder = new TFolder();
  folder.path = path;
  return folder;
}

const folderApp = {
  vault: {
    getAllLoadedFiles: () => [
      stubFolder('b'),
      stubFolder('/'),
      stubFolder('a'),
      stubFolder('b'),
    ],
  },
};
check(
  '目录：去重、根目录在前、上次目录置顶',
  T.collectFolders(folderApp, 'a').map((f) => f.path),
  ['a', '/', 'b']
);

const modernVaultApp = {
  vault: {
    getAllFolders: () => [stubFolder('/'), stubFolder('AI 表征/文献阅读笔记')],
    getAllLoadedFiles: () => [],
  },
};
check(
  '目录：优先使用 getAllFolders',
  T.collectFolders(modernVaultApp, '').map((f) => f.path),
  ['/', 'AI 表征/文献阅读笔记']
);

/* ---------------- 标签联动：纯函数 ---------------- */

const noteSample =
  '- **标题**：Formats of representation in large language models\n' +
  '- **Zotero 条目**：[在 Zotero 中打开](zotero://select/library/items/FUMSLPI2)\n' +
  '- **原文 PDF**：[打开 PDF](zotero://open-pdf/library/items/63CSJYXA)\n';

const parsedNote = T.parseNoteIndexEntry(noteSample);
check('索引：从条目链接取 key', parsedNote && parsedNote.key, 'FUMSLPI2');
check('索引：不把附件 key 当条目 key', parsedNote && parsedNote.key === '63CSJYXA', false);
check('索引：取到标题', parsedNote && parsedNote.title, 'Formats of representation in large language models');
check('索引：没有条目链接返回 null', T.parseNoteIndexEntry('no zotero link'), null);
check(
  '索引：open-pdf 单独出现不算',
  T.parseNoteIndexEntry('[打开 PDF](zotero://open-pdf/library/items/63CSJYXA)'),
  null
);
check(
  'key 提取：容忍链接后标点',
  T.extractItemKey('(zotero://select/library/items/abcd1234)。'),
  'ABCD1234'
);

const mergedKeepType = T.mergeTags([{ tag: '#在读', type: 1 }, { tag: '旧' }], ['#带obs笔记'], []);
check('合并：保留旧标签与颜色类型', mergedKeepType.merged, [
  { tag: '#在读', type: 1 },
  { tag: '旧' },
  { tag: '#带obs笔记' },
]);
check('合并：记录新增', mergedKeepType.added, ['#带obs笔记']);
check('合并：changed 为真', mergedKeepType.changed, true);

const mergedAgain = T.mergeTags([{ tag: '#带obs笔记' }], ['#带obs笔记'], []);
check('合并：已有同名标签不重复添加', mergedAgain.merged, [{ tag: '#带obs笔记' }]);
check('合并：无变化时 changed 为假', mergedAgain.changed, false);

const mergedRemove = T.mergeTags([{ tag: 'a' }, { tag: '#带obs笔记' }, { tag: 'b' }], [], ['#带obs笔记']);
check('合并：按精确名删除', mergedRemove.merged, [{ tag: 'a' }, { tag: 'b' }]);
check('合并：记录实际删除', mergedRemove.removed, ['#带obs笔记']);
check('合并：删除也算 changed', mergedRemove.changed, true);

const legacySettings = T.normalizeSettings({ apiBase: 'http://x/api/users/0' });
check('设置：旧数据补默认标签', legacySettings.zoteroTag, '#带obs笔记');
check('设置：默认自动加标签', legacySettings.autoTagOnCreate, true);
check('设置：默认删除时移除', legacySettings.removeTagOnDelete, true);
check('设置：索引初始为空对象', legacySettings.noteIndex, {});
check('设置：待办初始为空数组', legacySettings.pendingTagOps, []);
check('设置：无授权为 null', legacySettings.zoteroAuth, null);
const cloned = T.normalizeSettings({ noteIndex: { 'a.md': { key: 'AAAAAAAA' } } });
check('设置：保留已有索引', cloned.noteIndex['a.md'].key, 'AAAAAAAA');
cloned.noteIndex['b.md'] = { key: 'BBBBBBBB' };
check('设置：不与原始数据共享索引对象', Object.keys(legacySettings.noteIndex).length, 0);

/* ---------------- 异步：插件方法 ---------------- */

const http = require('http');

async function rejectionMessage(promise) {
  try {
    await promise;
    return '(未报错)';
  } catch (err) {
    return String(err && err.message ? err.message : err);
  }
}

async function rejectionCode(promise) {
  try {
    await promise;
    return '(未报错)';
  } catch (err) {
    return err && err.code ? err.code : '(无 code)';
  }
}

async function asyncChecks() {
  const plugin = Object.create(Plugin.prototype);
  plugin.settings = { templatePath: 'templates/文献笔记模板.md' };

  const seenAgents = [];
  let mode = 'pdf';

  // 模拟 Zotero 的写入侧状态
  const writeState = {
    serverId: 'SRV-TEST',
    tags: {},
    versions: {},
    patchLog: [],
    authorizeMode: 'remember',
    authRequests: 0,
    authPaths: [],
    failPatchStatus: 0,
    conflictOnce: false,
  };

  const server = http.createServer((req, res) => {
    const ua = req.headers['user-agent'] || '';
    seenAgents.push(ua);

    // 复刻 Zotero 的行为：浏览器 UA 或带 Origin 的请求直接断开
    if (ua.indexOf('Mozilla') === 0 || req.headers.origin) {
      req.socket.destroy();
      return;
    }
    if (mode === 'hang') return;
    if (mode === 'error') {
      res.statusCode = 500;
      res.end('boom');
      return;
    }
    if (mode === 'notjson') {
      res.end('<html>not json</html>');
      return;
    }
    // 所有响应都带 server id，和真实 Zotero 一样
    res.setHeader('Zotero-Server-ID', writeState.serverId);

    const pathOnly = req.url.split('?')[0];

    if (pathOnly.indexOf('/local/authorize') !== -1 && req.method === 'POST') {
      writeState.authRequests += 1;
      writeState.authPaths.push(pathOnly);
      req.resume();
      if (writeState.authorizeMode === 'deny') {
        res.statusCode = 403;
        res.end('{}');
        return;
      }
      if (writeState.authorizeMode === 'rate') {
        res.statusCode = 429;
        res.end('{}');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ key: 'TESTKEY', remember: writeState.authorizeMode === 'remember' })
      );
      return;
    }

    if (req.url.indexOf('/better-bibtex/cayw') !== -1) {
      if (req.url.indexOf('probe=true') !== -1) {
        res.end('ready');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(caywSample);
      return;
    }
    if (req.url.indexOf('/items?limit=1') !== -1) {
      res.end('[]');
      return;
    }

    const itemMatch = pathOnly.match(/\/items\/([A-Za-z0-9]{8})$/);
    if (itemMatch && req.method === 'GET') {
      const key = itemMatch[1];
      const tags = writeState.tags[key] || [];
      const version = writeState.versions[key] || 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          key: key,
          version: version,
          data: { key: key, itemType: 'journalArticle', tags: tags },
        })
      );
      return;
    }
    if (itemMatch && req.method === 'PATCH') {
      const key = itemMatch[1];
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        writeState.patchLog.push({ key: key, headers: req.headers, body: body });
        if (writeState.failPatchStatus) {
          const status = writeState.failPatchStatus;
          writeState.failPatchStatus = 0;
          res.statusCode = status;
          res.end('{}');
          return;
        }
        const current = writeState.versions[key] || 1;
        if (writeState.conflictOnce) {
          // 模拟「读完之后条目被别人改过」：版本前进，本次 PATCH 返回 412
          writeState.conflictOnce = false;
          writeState.versions[key] = current + 1;
          res.statusCode = 412;
          res.end('{}');
          return;
        }
        if (String(req.headers['if-unmodified-since-version']) !== String(current)) {
          res.statusCode = 412;
          res.end('{}');
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          res.statusCode = 400;
          res.end('{}');
          return;
        }
        writeState.tags[key] = (parsed.tags || []).map((t) => ({ tag: t.tag }));
        writeState.versions[key] = current + 1;
        res.setHeader('Zotero-Library-Version', '99');
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    if (req.url.indexOf('/items/AYVXCS2Y/children') !== -1) {
      res.end('[]');
      return;
    }
    if (req.url.indexOf('/items/K1/children') !== -1) {
      const body =
        mode === 'nopdf'
          ? [{ key: 'ATT2', data: { itemType: 'attachment', contentType: 'text/html' } }]
          : [
              { key: 'ATT1', data: { itemType: 'attachment', contentType: 'application/pdf' } },
              { key: 'ATT2', data: { itemType: 'attachment', contentType: 'text/html' } },
            ];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiBase = 'http://127.0.0.1:' + server.address().port + '/api/users/0';

  try {
    check(
      '方法：找到 PDF 附件',
      await plugin.findPdfLink(apiBase, 'K1'),
      '[打开 PDF](zotero://open-pdf/library/items/ATT1)'
    );
    checkTrue('方法：请求带非浏览器 UA', seenAgents[0] === T.USER_AGENT);
    checkTrue('方法：UA 不以 Mozilla 开头', seenAgents[0].indexOf('Mozilla') !== 0);
    checkTrue(
      '方法：UA 头能通过 Zotero 的浏览器拦截',
      seenAgents.every((ua) => ua.indexOf('Mozilla') !== 0)
    );

    mode = 'nopdf';
    check('方法：无 PDF 附件返回空串', await plugin.findPdfLink(apiBase, 'K1'), '');

    mode = 'error';
    check('方法：HTTP 500 时静默回退', await plugin.findPdfLink(apiBase, 'K1'), '');

    mode = 'pdf';
    check(
      '方法：API 地址末尾斜杠被容忍',
      await plugin.findPdfLink(apiBase + '/', 'K1'),
      '[打开 PDF](zotero://open-pdf/library/items/ATT1)'
    );

    checkTrue('CAYW：probe 判定可用', await plugin.probeCayw(apiBase), true);
    check('CAYW：probe 返回原文', (await T.httpGet(T.caywProbeUrl(apiBase), 3000)).trim(), 'ready');

    StubNotice.messages.length = 0;
    const picked = await plugin.pickFromZotero(apiBase);
    check('CAYW：插件取回条目 key', picked && picked.key, 'AYVXCS2Y');
    check(
      'CAYW：插件取回标题',
      picked && picked.data && picked.data.title,
      'The Border Between Seeing and Thinking'
    );
    checkTrue('CAYW：等待期间有提示且随后收起', StubNotice.messages.length >= 1);

    mode = 'error';
    check('CAYW：probe 失败时判定不可用', await plugin.probeCayw(apiBase), false);

    mode = 'pdf';

    mode = 'error';
    check(
      '方法：HTTP 错误信息带状态码',
      (await rejectionMessage(T.apiGet(apiBase, '/items/K1/children?format=json', 3000))).indexOf(
        'HTTP 500'
      ) !== -1,
      true
    );

    mode = 'notjson';
    check(
      '方法：非 JSON 响应有明确提示',
      (await rejectionMessage(T.apiGet(apiBase, '/items/K1', 3000))).indexOf('不是 JSON') !== -1,
      true
    );

    mode = 'hang';
    const started = Date.now();
    const hangMessage = await rejectionMessage(T.apiGet(apiBase, '/items/K1', 300));
    checkTrue('方法：超时会中断', hangMessage.indexOf('超时') !== -1);
    checkTrue('方法：超时按设定时长触发', Date.now() - started < 3000);
    mode = 'pdf';

    check(
      '方法：端口不通时报连接错误',
      (await rejectionMessage(T.apiGet('http://127.0.0.1:1/api/users/0', '/items', 1000))).length >
        0,
      true
    );

    StubNotice.messages.length = 0;
    plugin.app = { vault: { getAbstractFileByPath: () => null } };
    check('方法：模板缺失时回退内置模板', (await plugin.readTemplate()) === templateText, true);
    check('方法：模板缺失时有提示', StubNotice.messages.length, 1);
    StubNotice.messages.length = 0;
    const customTemplate = new TFile();
    customTemplate.path = 'templates/文献笔记模板.md';
    plugin.app = {
      vault: {
        getAbstractFileByPath: (p) => (p === customTemplate.path ? customTemplate : null),
        cachedRead: async () => 'SINGLE {{title}}',
      },
    };
    check('方法：读取自定义模板', await plugin.readTemplate(), 'SINGLE {{title}}');
    check('方法：命中文件时不发提示', StubNotice.messages.length, 0);

    async function makeCreateHarness(pick) {
      const state = { created: [], foldersMade: [], savedSettings: [], opened: [], files: new Map(), tagged: [] };
      const instance = Object.create(Plugin.prototype);
      instance.app = {
        vault: {
          getAllFolders: () => [stubFolder('/'), stubFolder('AI 表征/文献阅读笔记')],
          getAbstractFileByPath: (p) => state.files.get(p) || null,
          createFolder: async (p) => { state.foldersMade.push(p); },
          create: async (p, c) => {
            const file = new TFile();
            file.path = p;
            state.files.set(p, file);
            state.created.push({ path: p, content: c });
            return file;
          },
          cachedRead: async () => '',
        },
        workspace: { getLeaf: () => ({ openFile: async (file) => state.opened.push(file.path) }) },
      };
      instance.settings = T.normalizeSettings({
        apiBase: apiBase,
        zoteroAuth: { key: 'TESTKEY', serverId: 'SRV-TEST' },
        lastFolder: 'AI 表征/文献阅读笔记',
      });
      instance.pickItem = async () => pick;
      const harnessServer = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end('[]');
      });
      await new Promise((resolve) => harnessServer.listen(0, '127.0.0.1', resolve));
      instance.settings.apiBase = 'http://127.0.0.1:' + harnessServer.address().port + '/api/users/0';
      const closeHarness = () => new Promise((resolve) => harnessServer.close(resolve));
      instance.findPdfLink = async () => '[打开 PDF](zotero://open-pdf/library/items/PDFATT)';
      instance.saveData = async (data) => { state.savedSettings.push(data); };
      instance.tagNote = async (key, title, filePath) => { state.tagged.push({ key: key, title: title, filePath: filePath }); };
      return { plugin: instance, state: state, close: closeHarness };
    }
    const articleHarness = await makeCreateHarness(mallory);
    await articleHarness.plugin.createNote();
    const articlePath = 'AI 表征/文献阅读笔记/mallory2026Formatsofrepresentation.md';
    check('回归 journalArticle：仍只生成一个 Markdown', articleHarness.state.created.map((entry) => entry.path), [articlePath]);
    checkTrue('回归 journalArticle：仍是单篇模板', articleHarness.state.created[0].content.indexOf('# 全文详细解析') !== -1);
    check('回归 journalArticle：无书目录', articleHarness.state.foldersMade.indexOf('AI 表征/文献阅读笔记/mallory2026Formatsofrepresentation'), -1);
    check('回归 journalArticle：标签联动保留', articleHarness.state.tagged[0].key, 'ABCD1234');
    await articleHarness.close();
    const section = JSON.parse(JSON.stringify(mallory));
    section.key = 'SECT1234';
    section.data.itemType = 'bookSection';
    const sectionHarness = await makeCreateHarness(section);
    await sectionHarness.plugin.createNote();
    check('回归 bookSection：不当整本书', sectionHarness.state.created.length, 1);
    checkTrue('回归 bookSection：仍是根目录下单文件', sectionHarness.state.created[0].path === articlePath);
    checkTrue('回归 bookSection：没有 book.json', !Array.from(sectionHarness.state.files.keys()).some((p) => /book\.json$/.test(p)));
    await sectionHarness.close();

    // 单篇版不再区分专著：itemType=book 也只建一篇笔记，不建目录、不写 book.json。
    const bookHarness = await makeCreateHarness(JSON.parse(JSON.stringify(T.parseCaywResponse(caywSample)[0])));
    await bookHarness.plugin.createNote();
    check(
      '回归 book：只生成一个 Markdown',
      bookHarness.state.created.map((entry) => entry.path),
      ['AI 表征/文献阅读笔记/block2023TheBorderBetween.md']
    );
    checkTrue('回归 book：用单篇模板', bookHarness.state.created[0].content.indexOf('# 全文详细解析') !== -1);
    checkTrue(
      '回归 book：不写 book.json',
      !Array.from(bookHarness.state.files.keys()).some((p) => /book\.json$/.test(p))
    );
    checkTrue(
      '回归 book：不建以条目命名的子目录',
      bookHarness.state.foldersMade.every((p) => p.indexOf('block2023TheBorderBetween') === -1)
    );
    check('回归 book：标签联动保留', bookHarness.state.tagged[0].key, 'AYVXCS2Y');
    await bookHarness.close();

    /* ---------------- 上手功能：默认值、诊断文本、模板安装 ---------------- */

    check('默认值：lastFolder 为空，不指向任何个人目录', T.DEFAULT_SETTINGS.lastFolder, '');
    check('默认值：调试日志默认关闭', T.DEFAULT_SETTINGS.debugLog, false);
    check('默认值：首次向导默认未完成', T.DEFAULT_SETTINGS.setupDone, false);

    const diagText = T.formatDiagnostics([
      { label: 'Zotero 本地 API', ok: true, detail: 'http://127.0.0.1:23119/api/users/0' },
      { label: '模板文件', ok: false, detail: 'templates/文献笔记模板.md 不存在，将使用内置模板' },
    ]);
    const diagLines = diagText.split('\n');
    checkTrue('诊断文本：首行含版本号', diagLines[0].indexOf('v' + T.VERSION) !== -1);
    checkTrue('诊断文本：首行说明来源', diagLines[0].indexOf('文献笔记生成器（单篇版）') === 0);
    check('诊断文本：通过项', diagLines[1], '[ok] Zotero 本地 API — http://127.0.0.1:23119/api/users/0');
    check(
      '诊断文本：失败项',
      diagLines[2],
      '[!]  模板文件 — templates/文献笔记模板.md 不存在，将使用内置模板'
    );
    check('诊断文本：行数', diagLines.length, 3);

    const installState = { created: [], foldersMade: [] };
    const installer = Object.create(Plugin.prototype);
    installer.app = {
      vault: {
        getAbstractFileByPath: (p) => installState.created.find((entry) => entry.path === p) || null,
        createFolder: async (p) => {
          installState.foldersMade.push(p);
        },
        create: async (p, content) => {
          const file = new TFile();
          file.path = p;
          installState.created.push({ path: p, content: content });
          return file;
        },
      },
    };
    installer.settings = T.normalizeSettings({});
    StubNotice.messages.length = 0;
    check('模板安装：首次返回 true', await installer.installTemplate(), true);
    check('模板安装：写到设置里的模板路径', installState.created.map((entry) => entry.path), [
      'templates/文献笔记模板.md',
    ]);
    check('模板安装：内容即内置模板', installState.created[0].content, T.DEFAULT_TEMPLATE);
    check('模板安装：自动建父目录', installState.foldersMade, ['templates']);
    checkTrue('模板安装：成功后给提示', StubNotice.messages[0].indexOf('已把内置模板写入') !== -1);
    StubNotice.messages.length = 0;
    check('模板安装：已存在时不覆盖', await installer.installTemplate(), false);
    check('模板安装：已存在时不再写文件', installState.created.length, 1);
    checkTrue('模板安装：已存在时提示未覆盖', StubNotice.messages[0].indexOf('（未覆盖）') !== -1);

    // 依赖声明：诊断面板要能说清「不需要其他插件」，并如实列出当前启用的几个。
    const hintProbe = Object.create(Plugin.prototype);
    hintProbe.app = { plugins: { enabledPlugins: new Set(['templater-obsidian', 'dataview']) } };
    check(
      '依赖提示：列出已启用的 Templater 与 Dataview',
      hintProbe.installedPluginHint(),
      '（当前已启用：Templater、Dataview，与本插件互不依赖）'
    );
    hintProbe.app.plugins.enabledPlugins = new Set();
    check('依赖提示：都没启用时为空串', hintProbe.installedPluginHint(), '');
    hintProbe.app = {};
    check('依赖提示：读不到插件注册表时不报错', hintProbe.installedPluginHint(), '');

    /* ---------------- 标签联动：写入协议 ---------------- */

    writeState.authorizeMode = 'remember';
    const auth = await T.authorizeWrite(apiBase, writeState.serverId);
    check('授权：Always Allow 返回 key 与 remember', auth, { key: 'TESTKEY', remember: true });
    check(
      '授权：端点是全局 /api/local/authorize',
      writeState.authPaths[writeState.authPaths.length - 1],
      '/api/local/authorize'
    );
    const authWithSlash = await T.authorizeWrite(apiBase + '/', writeState.serverId);
    check('授权：容忍 apiBase 末尾斜杠', authWithSlash.key, 'TESTKEY');

    writeState.authorizeMode = 'deny';
    check(
      '授权：Deny 映射为 AUTH_DENIED',
      await rejectionCode(T.authorizeWrite(apiBase, writeState.serverId)),
      'AUTH_DENIED'
    );
    writeState.authorizeMode = 'rate';
    check(
      '授权：429 映射为 AUTH_RATE_LIMITED',
      await rejectionCode(T.authorizeWrite(apiBase, writeState.serverId)),
      'AUTH_RATE_LIMITED'
    );
    writeState.authorizeMode = 'remember';

    check('server id：从响应头学到', await T.readServerId(apiBase), 'SRV-TEST');

    writeState.tags['ABCD1234'] = [{ tag: '#在读', type: 1 }];
    writeState.versions['ABCD1234'] = 3;
    writeState.patchLog.length = 0;
    const added = await T.updateItemTags(apiBase, 'ABCD1234', {
      auth: { key: 'TESTKEY', serverId: 'SRV-TEST' },
      add: ['#带obs笔记'],
    });
    check('写入：合并后状态 updated', added.status, 'updated');
    check(
      '写入：保留旧标签并追加新标签',
      writeState.tags['ABCD1234'].map((t) => t.tag),
      ['#在读', '#带obs笔记']
    );
    check(
      '写入：PATCH 带版本前置条件',
      writeState.patchLog[0].headers['if-unmodified-since-version'],
      '3'
    );
    check('写入：PATCH 带 API key', writeState.patchLog[0].headers['zotero-api-key'], 'TESTKEY');
    check('写入：PATCH 带 server id', writeState.patchLog[0].headers['zotero-server-id'], 'SRV-TEST');
    check('写入：PATCH 体只含 tags', JSON.parse(writeState.patchLog[0].body), {
      tags: [{ tag: '#在读', type: 1 }, { tag: '#带obs笔记' }],
    });

    writeState.patchLog.length = 0;
    const unchanged = await T.updateItemTags(apiBase, 'ABCD1234', {
      auth: { key: 'TESTKEY', serverId: 'SRV-TEST' },
      add: ['#带obs笔记'],
    });
    check('写入：已有标签时 unchanged', unchanged.status, 'unchanged');
    check('写入：无变化不发 PATCH', writeState.patchLog.length, 0);

    writeState.versions['ABCD1234'] = 7;
    writeState.conflictOnce = true;
    writeState.patchLog.length = 0;
    const retried = await T.updateItemTags(apiBase, 'ABCD1234', {
      auth: { key: 'TESTKEY', serverId: 'SRV-TEST' },
      add: ['#综述'],
    });
    check('写入：412 后重读重试成功', retried.status, 'updated');
    check('写入：冲突时一共 PATCH 两次', writeState.patchLog.length, 2);
    check(
      '写入：重试后新标签仍在',
      writeState.tags['ABCD1234'].map((t) => t.tag),
      ['#在读', '#带obs笔记', '#综述']
    );

    writeState.failPatchStatus = 401;
    check(
      '写入：401 映射为 AUTH_EXPIRED',
      await rejectionCode(
        T.updateItemTags(apiBase, 'ABCD1234', {
          auth: { key: 'TESTKEY', serverId: 'SRV-TEST' },
          add: ['#x'],
        })
      ),
      'AUTH_EXPIRED'
    );

    /* ---------------- 标签联动：删除 / 重命名 / 待办 ---------------- */

    const tagPlugin = Object.create(Plugin.prototype);
    tagPlugin.settings = T.normalizeSettings({
      apiBase: apiBase,
      zoteroAuth: { key: 'TESTKEY', serverId: 'SRV-TEST' },
      noteIndex: {
        'AI 表征/文献阅读笔记/a.md': { key: 'DEL12345', title: 'A', addedAt: 1 },
      },
    });
    tagPlugin.saveData = async () => {};
    tagPlugin.app = { vault: {} };

    writeState.tags['DEL12345'] = [{ tag: '#在读' }, { tag: '#带obs笔记' }];
    writeState.versions['DEL12345'] = 11;
    const delFile = new TFile();
    delFile.path = 'AI 表征/文献阅读笔记/a.md';
    delFile.basename = 'a';
    StubNotice.messages.length = 0;
    await tagPlugin.onNoteDeleted(delFile);
    check('删除：最后一篇笔记时移除标签', writeState.tags['DEL12345'].map((t) => t.tag), ['#在读']);
    checkTrue(
      '删除：有移除提示',
      StubNotice.messages.some((m) => m.indexOf('已从 Zotero 条目移除标签') !== -1)
    );
    check(
      '删除：索引同步删除',
      tagPlugin.settings.noteIndex['AI 表征/文献阅读笔记/a.md'],
      undefined
    );

    writeState.tags['MULTI123'] = [{ tag: '#带obs笔记' }];
    writeState.versions['MULTI123'] = 1;
    tagPlugin.settings.noteIndex = {
      'x/a.md': { key: 'MULTI123', title: 'M' },
      'x/b.md': { key: 'MULTI123', title: 'M' },
    };
    const multiFile = new TFile();
    multiFile.path = 'x/a.md';
    multiFile.basename = 'a';
    StubNotice.messages.length = 0;
    await tagPlugin.onNoteDeleted(multiFile);
    check('删除：还有别的笔记时保留标签', writeState.tags['MULTI123'].map((t) => t.tag), [
      '#带obs笔记',
    ]);
    checkTrue(
      '删除：保留时有提示',
      StubNotice.messages.some((m) => m.indexOf('保留标签') !== -1)
    );

    const noAuthPlugin = Object.create(Plugin.prototype);
    noAuthPlugin.settings = T.normalizeSettings({
      noteIndex: { 'q/a.md': { key: 'QUEUE123', title: 'Q' } },
    });
    noAuthPlugin.saveData = async () => {};
    noAuthPlugin.app = { vault: {} };
    writeState.tags['QUEUE123'] = [{ tag: '#带obs笔记' }];
    const queueFile = new TFile();
    queueFile.path = 'q/a.md';
    queueFile.basename = 'a';
    StubNotice.messages.length = 0;
    await noAuthPlugin.onNoteDeleted(queueFile);
    check('删除：无授权时不动 Zotero', writeState.tags['QUEUE123'].map((t) => t.tag), [
      '#带obs笔记',
    ]);
    check('删除：无授权时记入待办', noAuthPlugin.settings.pendingTagOps.length, 1);
    checkTrue(
      '删除：无授权有提示',
      StubNotice.messages.some((m) => m.indexOf('待移除标签') !== -1)
    );

    noAuthPlugin.settings.noteIndex = { 'old/a.md': { key: 'ABCD1234', title: 'A' } };
    const renamedFile = new TFile();
    renamedFile.path = 'new/a.md';
    renamedFile.basename = 'a';
    noAuthPlugin.onNoteRenamed(renamedFile, 'old/a.md');
    check(
      '重命名：索引迁到新路径',
      noAuthPlugin.settings.noteIndex['new/a.md'] &&
        noAuthPlugin.settings.noteIndex['new/a.md'].key,
      'ABCD1234'
    );
    check('重命名：旧路径移除', noAuthPlugin.settings.noteIndex['old/a.md'], undefined);

    const syncPlugin = Object.create(Plugin.prototype);
    syncPlugin.settings = T.normalizeSettings({
      apiBase: apiBase,
      zoteroAuth: { key: 'TESTKEY', serverId: 'SRV-TEST' },
      pendingTagOps: [
        { op: 'remove', key: 'SYNC1234', title: 'S', notePath: 's/a.md', at: 1, attempts: 0 },
        { op: 'add', key: 'SYNC5678', title: 'T', notePath: 's/b.md', at: 1, attempts: 0 },
      ],
    });
    syncPlugin.saveData = async () => {};
    syncPlugin.app = { vault: {} };
    writeState.tags['SYNC1234'] = [{ tag: '#带obs笔记' }, { tag: '#在读' }];
    writeState.versions['SYNC1234'] = 1;
    writeState.tags['SYNC5678'] = [];
    writeState.versions['SYNC5678'] = 1;
    StubNotice.messages.length = 0;
    const syncResult = await syncPlugin.syncPendingTags();
    check('同步：移除待办执行成功', writeState.tags['SYNC1234'].map((t) => t.tag), ['#在读']);
    check('同步：add 待办因笔记不存在被丢弃', writeState.tags['SYNC5678'].length, 0);
    check('同步：队列清空', syncPlugin.settings.pendingTagOps.length, 0);
    check('同步：返回完成数', syncResult.done, 1);
    checkTrue(
      '同步：有完成提示',
      StubNotice.messages.some((m) => m.indexOf('Zotero 标签同步') !== -1)
    );

    // Obsidian 的 selectSuggestion 顺序是「先 close() 再 onChooseSuggestion()」
    const modalApp = {
      vault: {
        getAllFolders: () => [stubFolder('/'), stubFolder('AI 表征/文献阅读笔记')],
      },
    };

    let chosen = 'UNSET';
    const modal = new T.FolderPickerModal(modalApp, 'AI 表征/文献阅读笔记', (value) => {
      chosen = value;
    });
    modal.onOpen();
    modal.onClose();
    modal.onChooseItem(modal.folders[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    check('目录弹窗：先 close 再回传选择仍能取到路径', chosen, 'AI 表征/文献阅读笔记');

    let cancelled = 'UNSET';
    const modal2 = new T.FolderPickerModal(modalApp, '', (value) => {
      cancelled = value;
    });
    modal2.onOpen();
    modal2.onClose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    check('目录弹窗：只关闭视为取消', cancelled, null);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ---------------- 汇总 ---------------- */

async function finish() {
  await asyncChecks();

  console.log('');
  if (failures.length) {
    for (const f of failures) {
      console.error('✗ ' + f.label);
      console.error('   实际：' + f.actual);
      console.error('   期望：' + f.expected);
    }
    console.error('');
    console.error('失败 ' + failures.length + ' 项，通过 ' + passed + ' 项。');
    process.exitCode = 1;
    return;
  }

  console.log('全部通过：' + passed + ' 项。');
}

finish().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
