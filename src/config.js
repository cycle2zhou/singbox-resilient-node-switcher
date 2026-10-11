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
  poolTimeoutMs: 5000,
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
];

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeProbeUrls(value) {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.probeUrls;
  const filtered = value.filter((url) => typeof url === 'string' && url.trim());
  return filtered.length > 0 ? filtered : DEFAULT_CONFIG.probeUrls;
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
  config.poolFailureRateThreshold = normalizePoolFailureRateThreshold(
    source.poolFailureRateThreshold,
    DEFAULT_CONFIG.poolFailureRateThreshold,
  );

  return config;
}
