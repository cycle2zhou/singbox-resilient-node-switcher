import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pluginPath = join(root, 'plugins/GFS/plugin-singbox-resilient-node-switcher.js');
const meta = JSON.parse(readFileSync(join(root, 'plugins/gfs.json'), 'utf8'));
const readme = readFileSync(join(root, 'README.md'), 'utf8');

test('元数据 id、url、path 与生成文件一致', () => {
  assert.equal(meta.id, 'plugin-singbox-resilient-node-switcher');
  assert.ok(meta.url.endsWith('plugin-singbox-resilient-node-switcher.js'), 'url 应指向插件文件名');
  assert.ok(meta.path.endsWith('plugin-singbox-resilient-node-switcher.js'), 'path 应指向插件文件名');
  assert.ok(existsSync(pluginPath), '生成插件文件应存在');
});

test('元数据触发器覆盖完整生命周期', () => {
  for (const trigger of ['on::manual', 'on::core::started', 'on::core::stopped', 'on::shutdown']) {
    assert.ok(meta.triggers.includes(trigger), `缺少触发器 ${trigger}`);
  }
});

test('README 声明默认值与 src/config.js 一致', () => {
  const expected = [
    DEFAULT_CONFIG.selectorName,
    ...DEFAULT_CONFIG.probeUrls,
    String(DEFAULT_CONFIG.watchIntervalMs),
    String(DEFAULT_CONFIG.watchTimeoutMs),
    String(DEFAULT_CONFIG.poolRefreshIntervalMs),
    String(DEFAULT_CONFIG.poolTimeoutMs),
    String(DEFAULT_CONFIG.poolConcurrency),
    String(DEFAULT_CONFIG.poolFailureRateThreshold),
    String(DEFAULT_CONFIG.failureThreshold),
    String(DEFAULT_CONFIG.recoveryThreshold),
    String(DEFAULT_CONFIG.initialCooldownMs),
    String(DEFAULT_CONFIG.maxCooldownMs),
    String(DEFAULT_CONFIG.minDwellMs),
    String(DEFAULT_CONFIG.degradationRatio),
    String(DEFAULT_CONFIG.degradationThreshold),
    String(DEFAULT_CONFIG.baselineWindow),
  ];
  for (const value of expected) {
    assert.ok(readme.includes(value), `README 应包含默认值 ${value}`);
  }
});

test('README 说明关键限制：URLTest 不接管、故障节点会恢复、主动探测不等于全部业务恢复', () => {
  assert.match(readme, /不接管 URLTest/);
  assert.match(readme, /不会被永久剔除/);
  assert.match(readme, /不等于所有真实业务请求均已恢复/);
});
