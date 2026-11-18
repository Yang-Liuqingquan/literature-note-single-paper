# 开发说明

面向想改代码或自己发版的人。使用说明见 [README.md](README.md)。

## 目录结构

```
.
├── main.src.js            # 源码：常量、纯函数、选择器、诊断面板、插件主体、设置页
├── 文献笔记模板.md          # 内置模板源文件，构建时被嵌进 main.js
├── build.js               # 把模板嵌入 main.src.js，生成 main.js
├── main.js                # 构建产物（Obsidian 实际加载的文件，需提交）
├── manifest.json          # 插件清单
├── styles.css             # 选择器与诊断面板样式（Obsidian 自动加载）
├── test/run.js            # 离线测试，打桩 obsidian 模块，不需要 Obsidian 与 Zotero
├── versions.json          # 插件版本 → 最低 Obsidian 版本
└── .github/workflows/release.yml
```

## 构建

```bash
node build.js
```

`build.js` 会把 `文献笔记模板.md` 原样写进 `main.src.js` 里的 `"__DEFAULT_TEMPLATE__"` 占位处，输出 `main.js`，并打印模板字符数与产物字节数。**改完 `main.src.js` 或模板都要重新构建**，否则 Obsidian 加载的还是旧的 `main.js`。

构建产物 `main.js` 要一起提交：Obsidian 的安装与 Release 都需要它。

## 测试

```bash
node test/run.js
```

- 纯 Node 环境，用 `Module._load` 把 `obsidian` 模块替换成桩，所以不需要开 Obsidian；
- 网络请求指向测试内起的本地 HTTP 服务，不会碰真实 Zotero；
- 覆盖：文件名规则、日期与类型映射、APA、占位符渲染、目录选择器回归、CAYW 解析、标签写入协议（授权/412 重试/合并）、诊断文本与模板安装、端到端建卡。

改完代码至少跑一遍 `node test/run.js`，全绿再构建。

## 版本号

三处保持一致：

1. `manifest.json` 的 `version`；
2. `main.src.js` 里的 `VERSION` 常量（诊断输出会带它）；
3. git tag（`1.0.0` 这种纯数字点分形式，不加 `v`）。

`versions.json` 记录每个版本要求的最低 Obsidian 版本，发新版时加一行：

```json
{
  "1.0.0": "1.4.0",
  "1.1.0": "1.4.0"
}
```

## 发布

```bash
# 1. 改版本号（manifest.json、main.src.js 的 VERSION）
# 2. 构建并测试
node build.js && node test/run.js
# 3. 提交并打 tag
git add -A
git commit -m "1.1.0"
git tag 1.1.0
git push origin main --tags
```

推 tag 会触发 `.github/workflows/release.yml`：先校验 tag 与 `manifest.json` 的版本一致，跑测试，重新构建 `main.js`，再把 `main.js`、`manifest.json`、`styles.css` 传到 GitHub Release。

## 上架 Obsidian 社区插件

1. 先确保本仓库符合[官方要求](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)：`manifest.json` 的 `description` 不以句号结尾、不超过 250 字符，`id` 不含 `obsidian` 字样；
2. 在 [obsidian-releases](https://github.com/obsidianmd/obsidian-releases) 仓库提交 PR，把你这个仓库加进 `community-plugins.json`；
3. 审核通过后用户即可在 Obsidian 内搜索安装。

## 代码约定

- 源码是单个 `main.src.js`，CommonJS，不用打包器；新增纯函数请同时加进文件末尾的 `__test__` 导出，方便写测试；
- 所有网络请求走 `httpRequest` / `httpGet` / `apiGet`（Node `http`/`https`），**不要用 Obsidian 的 `requestUrl`**：它会带 Chromium 的浏览器 UA，Zotero 会直接断开这类请求（表现为 `Empty reply from server`）；
- 界面文案保持中文；调试输出只在 `RUNTIME.debug` 打开时写 `last-run.log`；
- 样式写在 `styles.css`，不要在代码里注入 `<style>`。

## 手工验收入口

真机验证至少走一遍：

1. 关掉 Zotero → 跑「检查运行环境」，五条应报错或标黄且提示可操作；
2. 打开 Zotero → 再检查一遍，前两条应转绿；
3. 建一篇笔记：选条目、选目录、确认文献信息与 APA、确认文件已打开；
4. 去 Zotero 看条目上是否多了标签；
5. 删掉笔记，确认标签被撤；若有其他笔记引用同条目则应保留。
