/**
 * GUI.for.SingBox 插件适配层：把内联核心（__core）接入 GFS 插件生命周期。
 * 本文件由 scripts/build-plugin.js 与内联核心拼接为自包含插件单文件；
 * 运行时不通过相对路径或运行时 import 引用项目 src/。
 * 仅面向 GUI.for.SingBox，不包含 GUI.for.Clash 分支。
 */

export default (Plugin) => {
  const { ref, computed, h, resolveComponent } = Vue;

  const isRunning = ref(false);
  const snapshot = ref(null);

  let monitor = null;
  let apiClient = null;
  let refreshTimer = null;
  let persistTimer = null;
  let disposed = false;

  const stateFile = 'data/plugins/singbox-resilient-node-switcher/state.json';

  // 从当前 profile 解析 sing-box Clash API 控制面地址与密钥（仅 GFS）
  function resolveEndpoint() {
    const { currentProfile: profile } = Plugins.useProfilesStore();
    const clash = profile && profile.experimental && profile.experimental.clash_api;
    if (!clash) return null;
    const controller = clash.external_controller || '127.0.0.1:20123';
    const secret = clash.secret || '';
    const idx = controller.lastIndexOf(':');
    const host = idx >= 0 ? controller.slice(0, idx) : '127.0.0.1';
    const port = idx >= 0 ? controller.slice(idx + 1) : '20123';
    return { baseUrl: `http://${host}:${port}`, secret };
  }

  // 从 Plugin 配置项构建 monitor 配置（数值项转数字，交给 normalizeConfig 归一化）
  function buildConfig() {
    return {
      selectorName: Plugin.SelectorName,
      probeUrls: typeof Plugin.ProbeUrls === 'string'
        ? Plugin.ProbeUrls.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      watchIntervalMs: Number(Plugin.WatchIntervalMs),
      watchTimeoutMs: Number(Plugin.WatchTimeoutMs),
      maxDelayMs: Number(Plugin.MaxDelayMs),
      poolRefreshIntervalMs: Number(Plugin.PoolRefreshIntervalMs),
      poolTimeoutMs: Number(Plugin.PoolTimeoutMs),
      poolConcurrency: Number(Plugin.PoolConcurrency),
      poolFailureRateThreshold: Number(Plugin.PoolFailureRateThreshold),
      failureThreshold: Number(Plugin.FailureThreshold),
      recoveryThreshold: Number(Plugin.RecoveryThreshold),
      initialCooldownMs: Number(Plugin.InitialCooldownMs),
      maxCooldownMs: Number(Plugin.MaxCooldownMs),
      minDwellMs: Number(Plugin.MinDwellMs),
      degradationRatio: Number(Plugin.DegradationRatio),
      degradationThreshold: Number(Plugin.DegradationThreshold),
      slowThreshold: Number(Plugin.SlowThreshold),
      baselineWindow: Number(Plugin.BaselineWindow),
      optimizeRatio: Number(Plugin.OptimizeRatio),
      optimizeThreshold: Number(Plugin.OptimizeThreshold),
      stalkProbeDelayMs: Number(Plugin.StalkProbeDelayMs),
      stalkSuccessThreshold: Number(Plugin.StalkSuccessThreshold),
      preSwitchMaxProbe: Number(Plugin.PreSwitchMaxProbe),
      realProbeEnabled: Plugin.RealProbeEnabled,
      realProbeUrls: typeof Plugin.RealProbeUrls === 'string'
        ? Plugin.RealProbeUrls.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      realDelayMs: Number(Plugin.RealDelayMs),
      realProbeTimeoutMs: Number(Plugin.RealProbeTimeoutMs),
      realStalkTimeoutMs: Number(Plugin.RealStalkTimeoutMs),
      realSlowThreshold: Number(Plugin.RealSlowThreshold),
      realProbeIntervalMs: Number(Plugin.RealProbeIntervalMs),
      realStalkSuccessThreshold: Number(Plugin.RealStalkSuccessThreshold),
      eventLogLimit: Number(Plugin.EventLogLimit),
    };
  }

  function refreshSnapshot() {
    if (monitor) snapshot.value = monitor.getSnapshot();
  }

  function persistSnapshot() {
    if (!monitor || disposed) return;
    try {
      Plugins.WriteFile(stateFile, JSON.stringify(monitor.getSnapshot(), null, 2));
    } catch (error) {
      console.warn(`[${Plugin.name}]`, '状态写入失败', error);
    }
  }

  function stop() {
    if (monitor) {
      monitor.stop();
      monitor = null;
    }
    apiClient = null;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (persistTimer) {
      clearInterval(persistTimer);
      persistTimer = null;
    }
    isRunning.value = false;
    Plugin.status = 0;
    return 2;
  }

  function start() {
    if (isRunning.value) return 1;
    const endpoint = resolveEndpoint();
    if (!endpoint) {
      throw new Error('未找到当前 profile 的 experimental.clash_api 配置');
    }
    const kernelApi = Plugins.useKernelApiStore();
    if (!kernelApi.running) {
      throw new Error('核心未运行，无法开始监控');
    }
    const config = buildConfig();
    apiClient = __core.createClashApi({
      baseUrl: endpoint.baseUrl,
      secret: endpoint.secret,
      timeoutMs: config.poolTimeoutMs,
    });
    monitor = __core.createMonitor({
      api: apiClient,
      config,
      clock: Date,
      // 真实延迟探测用 native 层 HttpGet（无 CORS，默认走系统代理 20122 测真实代理延迟）。
      // 传 Connection: close 强制每次新建连接（含 TLS 握手），避免 Go http.Client 复用连接
      // 跳过 TLS 握手导致延迟系统性低估（实测复用连接 ~0.7s vs 新建连接 1.7~4.6s）。
      httpGetImpl: (url) => Plugins.HttpGet(url, { Connection: 'close' }),
      logger: {
        info: (...args) => console.log(`[${Plugin.name}]`, ...args),
        warn: (...args) => console.warn(`[${Plugin.name}]`, ...args),
        error: (...args) => console.error(`[${Plugin.name}]`, ...args),
      },
    });
    monitor.start();
    refreshSnapshot();
    refreshTimer = setInterval(refreshSnapshot, 2000);
    persistTimer = setInterval(persistSnapshot, 30000);
    isRunning.value = true;
    Plugin.status = 1;
    return 1;
  }

  function statusText(status) {
    switch (status) {
      case 'healthy':
        return '🟢 正常';
      case 'suspect':
        return '🟡 疑似故障';
      case 'cooldown':
        return '🔴 冷却中';
      case 'half-open':
        return '🔵 半开检测';
      default:
        return '❓ 未知';
    }
  }

  function createUI() {
    const component = {
      template: `
    <Card>
      <template #title-suffix>
        <div class="font-bold">
          {{ isRunning ? '监控中' : '已停止' }} · 当前节点：{{ currentNow || '-' }}
        </div>
      </template>
      <template #extra>
        <Button v-if="isRunning" type="primary" icon="pause" @click="handleStop()">停止</Button>
        <Button v-else type="primary" icon="play" @click="handleStart()">启动</Button>
      </template>
      <Alert v-if="lastError" type="warning" :message="'最近错误：' + lastError" style="margin-bottom: 8px" />
      <Table :data-source="rows" :columns="columns" size="small" />
      <div v-if="candidates.length" style="margin-top: 8px">
        <div class="font-bold" style="margin-bottom: 4px">候选池</div>
        <div>
          <Tag v-for="tag in candidates" :key="tag" style="margin-right: 4px">{{ tag }}</Tag>
        </div>
      </div>
    </Card>`,
      setup() {
        const columns = [
          {
            title: '节点名',
            key: 'tag',
            align: 'left',
            customRender({ value, record }) {
              if (!(record && record.isCurrent)) return value;
              return h(resolveComponent('Tag'), { color: 'green' }, () => `${value}（当前）`);
            },
          },
          {
            title: '状态',
            key: 'status',
            align: 'center',
            customRender({ value }) {
              return statusText(value);
            },
          },
          {
            title: '最近延迟',
            key: 'lastDelay',
            align: 'center',
            customRender({ value }) {
              return value == null ? '-' : value.toFixed(2) + 'ms';
            },
          },
          { title: '连续失败', key: 'failureCount', align: 'center' },
          { title: '连续成功', key: 'recoverySuccessCount', align: 'center' },
          {
            title: '冷却截止',
            key: 'cooldownUntil',
            align: 'center',
            customRender({ value }) {
              return value == null ? '-' : Plugins.formatRelativeTime(value);
            },
          },
        ];
        const rows = computed(() => {
          const snap = snapshot.value;
          if (!snap) return [];
          return snap.members
            .map((tag) => {
              const st = snap.nodeStates[tag] || {};
              return {
                tag,
                isCurrent: tag === snap.currentNow,
                status: st.status,
                lastDelay: st.lastDelay,
                failureCount: st.failureCount,
                recoverySuccessCount: st.recoverySuccessCount,
                cooldownUntil: st.cooldownUntil,
              };
            })
            .sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));
        });
        const currentNow = computed(() => (snapshot.value ? snapshot.value.currentNow : null));
        const lastError = computed(() => (snapshot.value ? snapshot.value.lastError : null));
        const candidates = computed(() => (snapshot.value ? snapshot.value.candidates : []));
        return {
          isRunning,
          currentNow,
          lastError,
          candidates,
          rows,
          columns,
          handleStart() {
            try {
              start();
            } catch (error) {
              Plugins.message.error(error.message || String(error));
            }
          },
          handleStop() {
            stop();
          },
        };
      },
    };
    const modal = Plugins.modal(
      {
        title: Plugin.name,
        maskClosable: true,
        submit: false,
        width: '85',
        height: '85',
        cancelText: 'common.close',
      },
      { default: () => h(component) }
    );
    return modal;
  }

  return {
    onRun() {
      createUI().open();
    },
    onCoreStarted() {
      try {
        start();
      } catch (error) {
        console.warn(`[${Plugin.name}]`, '核心启动后开始监控失败', error);
      }
    },
    onCoreStopped() {
      stop();
    },
    onShutdown() {
      disposed = true;
      stop();
    },
    onDispose() {
      disposed = true;
      stop();
    },
    onUninstall() {
      disposed = true;
      stop();
      try {
        Plugins.RemoveFile(stateFile);
      } catch (error) {
        console.warn(`[${Plugin.name}]`, '清理状态文件失败', error);
      }
    },
    onConfigure() {
      stop();
      try {
        start();
      } catch (error) {
        console.warn(`[${Plugin.name}]`, '配置变更后重启失败', error);
      }
    },
    Start() {
      return start();
    },
    Stop() {
      return stop();
    },
  };
};
