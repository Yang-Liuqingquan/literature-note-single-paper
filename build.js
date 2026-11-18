'use strict';

/*
 * 构建脚本：把单篇文献笔记模板嵌入 main.src.js，产出 main.js。
 * 用法：node build.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'main.src.js');
const TEMPLATE = path.join(ROOT, '文献笔记模板.md');
const OUT = path.join(ROOT, 'main.js');

const MARKER = '"__DEFAULT_TEMPLATE__"';

function main() {
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  let source = fs.readFileSync(SRC, 'utf8');

  const count = source.split(MARKER).length - 1;
  if (count !== 1) {
    throw new Error('main.src.js 中的单篇模板标记应恰好出现 1 次，实际 ' + count + ' 次');
  }
  source = source.replace(MARKER, JSON.stringify(template));

  fs.writeFileSync(OUT, source, 'utf8');

  console.log('已生成 ' + path.relative(ROOT, OUT));
  console.log('单篇模板字符数：' + template.length);
  console.log('产物字节数：' + Buffer.byteLength(source, 'utf8'));
}

main();
