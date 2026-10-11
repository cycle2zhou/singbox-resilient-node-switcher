# 设计讨论纪要：GUI.for.SingBox 的 Selector 故障切换

## 背景与目的

用户在 macOS 上遇到间歇性代理中断，核心日志反复出现 `dial tcp 18.183.49.68:50131: i/o timeout`；现有通用智能切换插件没有稳定避开故障出口。用户希望做 GUI.for.SingBox 专用、可配置、可开源并考虑投稿 Plugin-Hub 的插件，且明确要求故障节点过一段时间可以重新参与选择。现有 Generic 插件保留，不就地修改；发布 GitHub/提交 PR 需要另行授权。

## 已讨论的方案与取舍

1. 直接修复 Generic 插件：改动最少，但继续背负 GUI.for.Clash 兼容分支和 provider healthcheck 假设，难以明确专用行为；不采用。
2. 改写 sing-box 配置、强制替换 urltest：控制权较强，但与内核自身测速冲突、侵入性大；不采用。
3. 新建 GFS 专用 Selector 守护插件：只根据控制面实时同步、节点主动探测和连续失败证据选择，保留用户手动选择的可解释性；推荐。

## 决策链

- 只支持 GUI.for.SingBox，目标 `plugins/GFS/plugin-singbox-resilient-node-switcher.js`；本地项目 `/Users/cycle/Documents/Git/GitHub/singbox-resilient-node-switcher`。
- 只切换 `Selector`；`URLTest` 交给内核。`GET /proxies` 读取 `type/all/now`，`PUT /proxies/{selector}` 切换后再读取验证。动态控制面读取当前 profile 的地址和密钥，不硬编码本机端口。
- 以 `GET /proxies/{node}/delay` 的 HTTPS URL 主动检查节点，校验 HTTP 状态与正数 `delay`；不使用 sing-box 无效的 provider healthcheck。测速代表主动探测，不宣称全部业务可用。
- 节点连续失败后冷却，到期低频半开测试，连续成功后恢复；禁止永久剔除。建议可配置初始值：检测间隔 30 秒、超时 5 秒、并发 3、失败阈值 3、恢复阈值 2、初始冷却 120 秒、最大冷却 30 分钟、最短驻留 60 秒；最终以书面规格和验证结果为准。
- 不能仅凭同一 IP:端口判定相同节点或全部熔断；不自动删节点、不修改内核配置、不启动第三方程序。
- 对外部网络失效、API 不可用、核心未运行、组不存在或非 Selector，应停止切换并报告具体原因；不可把控制面失败归咎于全部节点。

## 需在书面规格厘清

- 监控单一或多个 Selector、是否默认开机自动监控；手动变更如何尊重、避免立刻切回。
- 如何判断探测请求的目标、请求超时，以及切换后的业务可用性与仅验证 `now` 的区分。
- 与 GUI 插件生命周期及更新元数据的兼容方式；真实客户端验证范围和无法无副作用模拟的部分。
