import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pluginPath = join(root, 'plugins/GFS/plugin-singbox-resilient-node-switcher.js');
const metaPath = join(root, 'plugins/gfs.json');

const pluginSource = readFileSync(pluginPath, 'utf8');
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

test('插件单文件可独立解析并导出默认工厂函数', async () => {
  const mod = await import(pathToFileURL(pluginPath).href);
  assert.equal(typeof mod.default, 'function');
});

test('插件源码不通过相对路径或运行时 import 引用项目 src/', () => {
  assert.doesNotMatch(pluginSource, /^\s*import\s/m, '不应包含 import 语句');
  assert.doesNotMatch(pluginSource, /import\s*\(/, '不应包含动态 import');
  assert.doesNotMatch(pluginSource, /from\s+['"][^'"]*src\//, '不应包含 src/ 路径导入');
});

test('插件源码不包含跨平台分支与危险操作', () => {
  assert.doesNotMatch(pluginSource, /APP_TITLE/, '不应包含 GUI.for.Clash 平台判断');
  assert.doesNotMatch(pluginSource, /advancedConfig/, '不应包含 Clash 高级配置');
  assert.doesNotMatch(pluginSource, /\/providers\//, '不应调用 provider 接口');
  assert.doesNotMatch(pluginSource, /healthcheck/i, '不应使用 provider healthcheck');
  assert.doesNotMatch(pluginSource, /\/configs\//, '不应写回 sing-box 配置');
  assert.doesNotMatch(pluginSource, /deleteProxy|removeProxy|删除节点/i, '不应删除节点');
});

test('插件源码不引用现有用户插件路径', () => {
  assert.doesNotMatch(pluginSource, /plugin-smart-proxy-switcher/);
  assert.doesNotMatch(pluginSource, /Application Support/);
});

test('Plugin-Hub 元数据字段齐全', () => {
  assert.equal(meta.id, 'plugin-singbox-resilient-node-switcher');
  assert.equal(meta.type, 'Http');
  assert.ok(meta.name, '缺少 name');
  assert.ok(meta.version, '缺少 version');
  assert.ok(meta.description, '缺少 description');
  assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0, '缺少 tags');
  assert.ok(meta.url.includes('plugin-singbox-resilient-node-switcher.js'), 'url 应指向插件文件');
  assert.ok(meta.path.endsWith('plugin-singbox-resilient-node-switcher.js'), 'path 应指向插件文件');
  assert.equal(meta.hasUI, true);
  assert.deepEqual(Object.keys(meta.menus).sort(), ['停止', '启动'], '缺少启停菜单');
  assert.ok(meta.triggers.includes('on::manual'), '缺少 on::manual 触发器');
  assert.ok(meta.triggers.includes('on::core::started'), '缺少 on::core::started 触发器');
  assert.ok(meta.triggers.includes('on::core::stopped'), '缺少 on::core::stopped 触发器');
  assert.ok(meta.triggers.includes('on::shutdown'), '缺少 on::shutdown 触发器');
});

test('元数据配置项齐全且默认值与 src/config.js 一致', () => {
  const expected = {
    SelectorName: DEFAULT_CONFIG.selectorName,
    ProbeUrls: DEFAULT_CONFIG.probeUrls.join(','),
    WatchIntervalMs: String(DEFAULT_CONFIG.watchIntervalMs),
    WatchTimeoutMs: String(DEFAULT_CONFIG.watchTimeoutMs),
    MaxDelayMs: String(DEFAULT_CONFIG.maxDelayMs),
    PoolRefreshIntervalMs: String(DEFAULT_CONFIG.poolRefreshIntervalMs),
    PoolTimeoutMs: String(DEFAULT_CONFIG.poolTimeoutMs),
    PoolConcurrency: String(DEFAULT_CONFIG.poolConcurrency),
    PoolFailureRateThreshold: String(DEFAULT_CONFIG.poolFailureRateThreshold),
    FailureThreshold: String(DEFAULT_CONFIG.failureThreshold),
    RecoveryThreshold: String(DEFAULT_CONFIG.recoveryThreshold),
    InitialCooldownMs: String(DEFAULT_CONFIG.initialCooldownMs),
    MaxCooldownMs: String(DEFAULT_CONFIG.maxCooldownMs),
    MinDwellMs: String(DEFAULT_CONFIG.minDwellMs),
    DegradationRatio: String(DEFAULT_CONFIG.degradationRatio),
    DegradationThreshold: String(DEFAULT_CONFIG.degradationThreshold),
    SlowThreshold: String(DEFAULT_CONFIG.slowThreshold),
    BaselineWindow: String(DEFAULT_CONFIG.baselineWindow),
    OptimizeRatio: String(DEFAULT_CONFIG.optimizeRatio),
    OptimizeThreshold: String(DEFAULT_CONFIG.optimizeThreshold),
    StalkProbeDelayMs: String(DEFAULT_CONFIG.stalkProbeDelayMs),
    StalkSuccessThreshold: String(DEFAULT_CONFIG.stalkSuccessThreshold),
    PreSwitchMaxProbe: String(DEFAULT_CONFIG.preSwitchMaxProbe),
  };

  for (const [key, value] of Object.entries(expected)) {
    const item = meta.configuration.find((c) => c.key === key);
    assert.ok(item, `缺少配置项 ${key}`);
    assert.equal(item.component, 'Input', `配置项 ${key} 应为 Input`);
    assert.equal(item.value, value, `配置项 ${key} 默认值应与 src/config.js 一致`);
  }
});

test('插件源码读取全部双通道配置键', () => {
  const keys = [
    'Plugin.WatchIntervalMs',
    'Plugin.WatchTimeoutMs',
    'Plugin.MaxDelayMs',
    'Plugin.PoolRefreshIntervalMs',
    'Plugin.PoolTimeoutMs',
    'Plugin.PoolConcurrency',
    'Plugin.PoolFailureRateThreshold',
    'Plugin.DegradationRatio',
    'Plugin.DegradationThreshold',
    'Plugin.SlowThreshold',
    'Plugin.BaselineWindow',
    'Plugin.ProbeUrls',
    'Plugin.OptimizeRatio',
    'Plugin.OptimizeThreshold',
    'Plugin.StalkProbeDelayMs',
    'Plugin.StalkSuccessThreshold',
    'Plugin.PreSwitchMaxProbe',
  ];
  for (const key of keys) {
    assert.ok(pluginSource.includes(key), `插件源码应读取 ${key}`);
  }
});

test('默认导出工厂返回完整生命周期钩子', async () => {
  const mod = await import(pathToFileURL(pluginPath).href);

  const vueRef = (v) => ({ value: v });
  globalThis.Vue = {
    ref: vueRef,
    computed: (fn) => ({ get value() { return fn(); } }),
    h: () => ({}),
  };
  globalThis.Plugins = {
    useProfilesStore: () => ({ currentProfile: null }),
    useKernelApiStore: () => ({ running: false, proxies: {} }),
    modal: () => ({ open() {} }),
    message: { error() {} },
    WriteFile() {},
    RemoveFile() {},
    formatRelativeTime: (v) => String(v),
  };

  try {
    const hooks = mod.default({ name: '节点弹性切换', status: 0 });
    const required = [
      'onRun',
      'onCoreStarted',
      'onCoreStopped',
      'onShutdown',
      'onDispose',
      'onUninstall',
      'onConfigure',
      'Start',
      'Stop',
    ];
    for (const key of required) {
      assert.equal(typeof hooks[key], 'function', `缺少钩子 ${key}`);
    }
  } finally {
    delete globalThis.Vue;
    delete globalThis.Plugins;
  }
});
