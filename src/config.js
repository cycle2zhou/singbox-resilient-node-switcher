export const DEFAULT_CONFIG = Object.freeze({
  selectorName: '🚀 节点选择',
  probeUrls: Object.freeze([
    'https://www.gstatic.com/generate_204',
    'https://www.google.com/generate_204',
    'https://github.com',
  ]),
  watchIntervalMs: 10000,
  watchTimeoutMs: 4000,
  maxDelayMs: 2000,
  poolRefreshIntervalMs: 180000,
  poolTimeoutMs: 2000,
  poolConcurrency: 20,
  poolFailureRateThreshold: 0.9,
  failureThreshold: 3,
  recoveryThreshold: 2,
  initialCooldownMs: 120000,
  maxCooldownMs: 1800000,
  minDwellMs: 60000,
  degradationRatio: 3,
  degradationThreshold: 2,
  slowThreshold: 2,
  baselineWindow: 5,
  optimizeRatio: 2,
  optimizeThreshold: 3,
  stalkProbeDelayMs: 2000,
  stalkSuccessThreshold: 2,
  preSwitchMaxProbe: 3,
  // 真实延迟探测：sing-box 的 /delay 用 HEAD 且不读 body，系统性低估真实 GET 访问延迟
  // （实测低 3~6 倍），导致 maxDelayMs 慢判定失效。真实延迟探测走系统代理（fetch 默认走
  // 系统代理，指向 sing-box 混合入站）发起真实 GET 并读 body，测到的就是用户实际感知延迟。
  realProbeEnabled: true,
  realProbeUrls: Object.freeze([
    'https://github.com',
    'https://www.google.com',
  ]),
  realDelayMs: 3000,
  realProbeMinSuccesses: 2,
  realProbeTimeoutMs: 8000,
  // 盯梢期（切换后快速检测）真实探测用更短超时，尽快发现「切到的节点其实慢/不通」
  realStalkTimeoutMs: 3000,
  realSlowThreshold: 2,
  // 真实探测单飞间隔：正常期每 realProbeIntervalMs 发起一次真实 GET，独立于 HEAD 快探周期
  realProbeIntervalMs: 15000,
  // 盯梢期退出阈值：真实 GET 连续 realStalkSuccessThreshold 次达标（延迟 ≤ realDelayMs）才退出盯梢
  realStalkSuccessThreshold: 2,
  // 事件时间线环形队列上限：详细事件仅保留在内存最近 N 条，state.json 只存聚合计数
  eventLogLimit: 50,
  scanIntervalMs: 10000,
  scanMainPoolSize: 20,
  scanExplorePoolSize: 5,
  scanScoreMax: 100,
  scanScoreInitial: 80,
  scanScoreHighThreshold: 90,
  scanScoreMediumThreshold: 80,
  scanScoreLowThreshold: 70,
  scanBackoffRounds: 6,
  scanSuccessStep: 5,
  scanFailureStep: 15,
  scanHttp503Step: 10,
  scanHttp504Step: 15,
  scanTimeoutStep: 20,
  scanRealFailureStep: 25,
  scanSlowStep: 5,
  foregroundReserved: 2,
  backgroundConcurrency: 3,
  backgroundBatchSize: 3,
  backgroundRoundDeadlineMs: 300000,
  backgroundBackoffMs: 30000,
  stabilityMode: 'stable-first',
  stabilityWindowMs: 600000,
  stabilityMaxSamples: 20,
  stabilityHeadMinSamples: 5,
  stabilityRealMinSamples: 3,
  stabilityRealLatencyMinSamples: 5,
  realStabilityProbeBudget: 3,
  stableSwitchRounds: 3,
  stabilitySwitchMargin: 8,
  latencySwitchMargin: 0.35,
  optimizeDwellMs: 300000,
  optimizeCooldownMs: 600000,
});

const POSITIVE_KEYS = [
  'watchIntervalMs',
  'watchTimeoutMs',
  'maxDelayMs',
  'poolRefreshIntervalMs',
  'poolTimeoutMs',
  'initialCooldownMs',
  'minDwellMs',
  'degradationRatio',
  'optimizeRatio',
  'stalkProbeDelayMs',
  'realDelayMs',
  'realProbeTimeoutMs',
  'realStalkTimeoutMs',
  'realProbeIntervalMs',
  'scanIntervalMs',
  'backgroundRoundDeadlineMs',
  'backgroundBackoffMs',
  'stabilityWindowMs',
  'stabilitySwitchMargin',
  'latencySwitchMargin',
  'optimizeDwellMs',
  'optimizeCooldownMs',
];

const POSITIVE_INTEGER_KEYS = [
  'poolConcurrency',
  'failureThreshold',
  'recoveryThreshold',
  'degradationThreshold',
  'slowThreshold',
  'baselineWindow',
  'optimizeThreshold',
  'stalkSuccessThreshold',
  'preSwitchMaxProbe',
  'realSlowThreshold',
  'realProbeMinSuccesses',
  'realStalkSuccessThreshold',
  'eventLogLimit',
  'scanIntervalMs',
  'foregroundReserved',
  'backgroundConcurrency',
  'backgroundBatchSize',
  'scanMainPoolSize',
  'scanExplorePoolSize',
  'scanScoreMax',
  'scanScoreInitial',
  'scanScoreHighThreshold',
  'scanScoreMediumThreshold',
  'scanScoreLowThreshold',
  'scanBackoffRounds',
  'scanSuccessStep',
  'scanFailureStep',
  'scanHttp503Step',
  'scanHttp504Step',
  'scanTimeoutStep',
  'scanRealFailureStep',
  'scanSlowStep',
  'stabilityMaxSamples',
  'stabilityHeadMinSamples',
  'stabilityRealMinSamples',
  'stabilityRealLatencyMinSamples',
  'realStabilityProbeBudget',
  'stableSwitchRounds',
];

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeProbeUrls(value, fallback = DEFAULT_CONFIG.probeUrls) {
  if (!Array.isArray(value)) return fallback;
  const filtered = value.filter((url) => typeof url === 'string' && url.trim());
  return filtered.length > 0 ? filtered : fallback;
}

function normalizePoolFailureRateThreshold(value, fallback) {
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

export function normalizeConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const config = { ...DEFAULT_CONFIG };

  for (const key of POSITIVE_KEYS) {
    config[key] = positiveNumber(source[key], DEFAULT_CONFIG[key]);
  }

  for (const key of POSITIVE_INTEGER_KEYS) {
    config[key] = positiveInteger(source[key], DEFAULT_CONFIG[key]);
  }

  config.maxCooldownMs = positiveNumber(source.maxCooldownMs, DEFAULT_CONFIG.maxCooldownMs);
  config.maxCooldownMs = Math.max(config.maxCooldownMs, config.initialCooldownMs);
  config.selectorName = typeof source.selectorName === 'string' && source.selectorName.trim()
    ? source.selectorName
    : DEFAULT_CONFIG.selectorName;

  config.probeUrls = normalizeProbeUrls(source.probeUrls);
  config.realProbeUrls = normalizeProbeUrls(source.realProbeUrls, DEFAULT_CONFIG.realProbeUrls);
  config.realProbeMinSuccesses = Math.min(config.realProbeMinSuccesses, config.realProbeUrls.length);
  config.realProbeEnabled = typeof source.realProbeEnabled === 'boolean'
    ? source.realProbeEnabled
    : DEFAULT_CONFIG.realProbeEnabled;
  config.stabilityMode = source.stabilityMode === 'latency-first' || source.stabilityMode === 'stable-first'
    ? source.stabilityMode
    : DEFAULT_CONFIG.stabilityMode;
  config.poolFailureRateThreshold = normalizePoolFailureRateThreshold(
    source.poolFailureRateThreshold,
    DEFAULT_CONFIG.poolFailureRateThreshold,
  );

  const scoreOrderValid =
    config.scanScoreMax >= config.scanScoreHighThreshold &&
    config.scanScoreHighThreshold >= config.scanScoreMediumThreshold &&
    config.scanScoreMediumThreshold >= config.scanScoreLowThreshold &&
    config.scanScoreInitial <= config.scanScoreMax;
  if (!scoreOrderValid) {
    config.scanScoreMax = DEFAULT_CONFIG.scanScoreMax;
    config.scanScoreInitial = DEFAULT_CONFIG.scanScoreInitial;
    config.scanScoreHighThreshold = DEFAULT_CONFIG.scanScoreHighThreshold;
    config.scanScoreMediumThreshold = DEFAULT_CONFIG.scanScoreMediumThreshold;
    config.scanScoreLowThreshold = DEFAULT_CONFIG.scanScoreLowThreshold;
  }

  return config;
}
