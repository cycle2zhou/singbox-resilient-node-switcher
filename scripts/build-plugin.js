#!/usr/bin/env node
/**
 * 构建脚本：把 src/ 下无 GUI 依赖的核心模块内联成自包含的 GFS 插件单文件。
 * 零第三方依赖；产物不通过相对路径或运行时 import 引用项目 src/。
 *
 * 用法：node scripts/build-plugin.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = join(root, 'plugins', 'GFS');
const outFile = join(outDir, 'plugin-singbox-resilient-node-switcher.js');

// 内联顺序：被依赖者在前（拓扑序）
const MODULE_ORDER = ['config.js', 'model.js', 'response.js', 'health-state.js', 'api.js', 'monitor.js'];

// 内联后暴露给适配层的公共 API
const EXPORTS = [
  'DEFAULT_CONFIG',
  'normalizeConfig',
  'createNodeState',
  'serializeNodeState',
  'parseDelayResponse',
  'createClashApi',
  'recordProbeFailure',
  'recordProbeSuccess',
  'getProbePlan',
  'isEligibleCandidate',
  'markCooldown',
  'createMonitor',
];

function inlineModule(name) {
  const src = readFileSync(join(root, 'src', name), 'utf8');
  const lines = src.split('\n');
  const out = [];
  let inImport = false;
  for (const line of lines) {
    if (inImport) {
      if (/;\s*$/.test(line)) inImport = false;
      continue;
    }
    if (/^\s*import\s/.test(line)) {
      if (!/;\s*$/.test(line)) inImport = true;
      continue;
    }
    out.push(line.replace(/^(\s*)export\s+/, '$1'));
  }
  return out.join('\n');
}

function buildCore() {
  const body = MODULE_ORDER.map((name) => `// ---- src/${name} ----\n${inlineModule(name)}`).join('\n\n');
  return `const __core = (() => {\n${body}\n  return {\n${EXPORTS.map((e) => `    ${e},`).join('\n')}\n  };\n})();`;
}

const adapter = readFileSync(join(__dirname, 'plugin-adapter.js'), 'utf8');

const header = [
  '/**',
  ' * GUI.for.SingBox 插件：弹性节点切换（可恢复冷却 + 谨慎故障切换）。',
  ' * 本文件由 scripts/build-plugin.js 自动生成，勿手改；来源 src/*.js + scripts/plugin-adapter.js。',
  ' * 自包含单文件：不通过相对路径或运行时 import 引用项目 src/。',
  ' */',
].join('\n');

const output = `${header}\n\n${buildCore()}\n\n${adapter}\n`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, output);
console.log(`已生成 ${outFile}（${Buffer.byteLength(output)} 字节）`);
