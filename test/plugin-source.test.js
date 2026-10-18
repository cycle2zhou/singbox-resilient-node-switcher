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

test('插件单文件包含运行时快照依赖定义，可在启动时创建 monitor', () => {
  assert.doesNotMatch(pluginSource, /function clone\s*\(/, '内联模块不得共享会互相覆盖的 clone 函数名');
  assert.doesNotMatch(pluginSource, /function normalizeConfig\s*\([^)]*\)\s*\{[\s\S]*function normalizeConfig\s*\(/, '内联模块不得共享 normalizeConfig 函数名');
  assert.match(pluginSource, /function createCandidateStore\s*\(/, '缺少 CandidateStore 内联实现');
  assert.match(pluginSource, /function createTopologySnapshot\s*\(/, '缺少 runtime-model 内联实现');
  assert.match(pluginSource, /function createCandidateSnapshot\s*\(/, '缺少候选快照内联实现');
  assert.match(pluginSource, /function createRuntimeState\s*\(/, '缺少 runtime-state 内联实现');
  assert.match(pluginSource, /function createStabilityScore\s*\(/, '缺少 stability-score 内联实现');
  assert.match(pluginSource, /function createOptimizationPolicy\s*\(/, '缺少 optimization-policy 内联实现');
  assert.match(pluginSource, /function createSchedulerState\s*\(/, '缺少 scheduler-model 内联实现');
});

test('生产插件只通过 SwitchCoordinator 调用 Selector PUT', () => {
  assert.match(pluginSource, /function createSwitchCoordinator\s*\(/, '缺少 SwitchCoordinator 内联实现');
  const directSelectCalls = pluginSource.match(/api\.select\(/g) || [];
  assert.equal(directSelectCalls.length, 1, '生产插件应只有协调器中的一个 api.select 调用点');
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
  for (const trigger of ['on::manual', 'on::startup', 'on::ready', 'on::core::started', 'on::core::stopped', 'on::shutdown']) {
    assert.ok(meta.triggers.includes(trigger), `缺少触发器 ${trigger}`);
  }
  assert.ok(!meta.triggers.includes('on::reload'), '不应注册未定义的重载触发器');
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
    RealProbeUrls: DEFAULT_CONFIG.realProbeUrls.join(','),
    RealDelayMs: String(DEFAULT_CONFIG.realDelayMs),
    RealProbeMinSuccesses: String(DEFAULT_CONFIG.realProbeMinSuccesses),
    RealProbeTimeoutMs: String(DEFAULT_CONFIG.realProbeTimeoutMs),
    RealStalkTimeoutMs: String(DEFAULT_CONFIG.realStalkTimeoutMs),
    RealSlowThreshold: String(DEFAULT_CONFIG.realSlowThreshold),
    RealProbeIntervalMs: String(DEFAULT_CONFIG.realProbeIntervalMs),
    RealStalkSuccessThreshold: String(DEFAULT_CONFIG.realStalkSuccessThreshold),
    EventLogLimit: String(DEFAULT_CONFIG.eventLogLimit),
    ScanIntervalMs: String(DEFAULT_CONFIG.scanIntervalMs),
    ScanMainPoolSize: String(DEFAULT_CONFIG.scanMainPoolSize),
    ScanExplorePoolSize: String(DEFAULT_CONFIG.scanExplorePoolSize),
    ScanScoreMax: String(DEFAULT_CONFIG.scanScoreMax),
    ScanScoreInitial: String(DEFAULT_CONFIG.scanScoreInitial),
    ScanScoreHighThreshold: String(DEFAULT_CONFIG.scanScoreHighThreshold),
    ScanScoreMediumThreshold: String(DEFAULT_CONFIG.scanScoreMediumThreshold),
    ScanScoreLowThreshold: String(DEFAULT_CONFIG.scanScoreLowThreshold),
    ScanBackoffRounds: String(DEFAULT_CONFIG.scanBackoffRounds),
    ScanSuccessStep: String(DEFAULT_CONFIG.scanSuccessStep),
    ScanFailureStep: String(DEFAULT_CONFIG.scanFailureStep),
    ScanHttp503Step: String(DEFAULT_CONFIG.scanHttp503Step),
    ScanHttp504Step: String(DEFAULT_CONFIG.scanHttp504Step),
    ScanTimeoutStep: String(DEFAULT_CONFIG.scanTimeoutStep),
    ScanRealFailureStep: String(DEFAULT_CONFIG.scanRealFailureStep),
    ScanSlowStep: String(DEFAULT_CONFIG.scanSlowStep),
    ForegroundReserved: String(DEFAULT_CONFIG.foregroundReserved),
    BackgroundConcurrency: String(DEFAULT_CONFIG.backgroundConcurrency),
    BackgroundBatchSize: String(DEFAULT_CONFIG.backgroundBatchSize),
    BackgroundRoundDeadlineMs: String(DEFAULT_CONFIG.backgroundRoundDeadlineMs),
    BackgroundBackoffMs: String(DEFAULT_CONFIG.backgroundBackoffMs),
    StabilityMode: DEFAULT_CONFIG.stabilityMode,
    StabilityWindowMs: String(DEFAULT_CONFIG.stabilityWindowMs),
    StabilityMaxSamples: String(DEFAULT_CONFIG.stabilityMaxSamples),
    StabilityHeadMinSamples: String(DEFAULT_CONFIG.stabilityHeadMinSamples),
    StabilityRealMinSamples: String(DEFAULT_CONFIG.stabilityRealMinSamples),
    StabilityRealLatencyMinSamples: String(DEFAULT_CONFIG.stabilityRealLatencyMinSamples),
    RealStabilityProbeBudget: String(DEFAULT_CONFIG.realStabilityProbeBudget),
    StableSwitchRounds: String(DEFAULT_CONFIG.stableSwitchRounds),
    StabilitySwitchMargin: String(DEFAULT_CONFIG.stabilitySwitchMargin),
    LatencySwitchMargin: String(DEFAULT_CONFIG.latencySwitchMargin),
    OptimizeDwellMs: String(DEFAULT_CONFIG.optimizeDwellMs),
    OptimizeCooldownMs: String(DEFAULT_CONFIG.optimizeCooldownMs),
  };

  for (const [key, value] of Object.entries(expected)) {
    const item = meta.configuration.find((c) => c.key === key);
    assert.ok(item, `缺少配置项 ${key}`);
    assert.equal(item.component, 'Input', `配置项 ${key} 应为 Input`);
    assert.equal(item.value, value, `配置项 ${key} 默认值应与 src/config.js 一致`);
  }

  // realProbeEnabled 用 Switch 组件承载布尔值
  const realProbeEnabled = meta.configuration.find((c) => c.key === 'RealProbeEnabled');
  assert.ok(realProbeEnabled, '缺少配置项 RealProbeEnabled');
  assert.equal(realProbeEnabled.component, 'Switch', 'RealProbeEnabled 应为 Switch');
  assert.equal(realProbeEnabled.value, DEFAULT_CONFIG.realProbeEnabled, 'RealProbeEnabled 默认值应与 src/config.js 一致');
});

test('插件界面不展示切换路径但保留内部状态字段', () => {
  assert.match(pluginSource, /lastSwitch:/, '内部快照应保留 lastSwitch 诊断字段');
  assert.doesNotMatch(pluginSource, /lastSwitchText/, '界面不应暴露长切换路径文本');
  assert.doesNotMatch(pluginSource, /上次切换|切换路径/, '界面不应展示切换路径标题');
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
    'Plugin.RealProbeEnabled',
    'Plugin.RealProbeUrls',
    'Plugin.RealDelayMs',
    'Plugin.RealProbeMinSuccesses',
    'Plugin.RealProbeTimeoutMs',
    'Plugin.RealStalkTimeoutMs',
    'Plugin.RealSlowThreshold',
    'Plugin.RealProbeIntervalMs',
    'Plugin.RealStalkSuccessThreshold',
    'Plugin.EventLogLimit',
    'Plugin.StabilityMode',
    'Plugin.StabilityWindowMs',
    'Plugin.StabilityMaxSamples',
    'Plugin.StabilityHeadMinSamples',
    'Plugin.StabilityRealMinSamples',
    'Plugin.StabilityRealLatencyMinSamples',
    'Plugin.RealStabilityProbeBudget',
    'Plugin.StableSwitchRounds',
    'Plugin.StabilitySwitchMargin',
    'Plugin.LatencySwitchMargin',
    'Plugin.OptimizeDwellMs',
    'Plugin.OptimizeCooldownMs',
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
      'onStartup',
      'onReady',
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
