## 1. 项目基础与公共模型

- [x] 1.1 建立原生 JavaScript ES module 项目骨架、测试命令和 README 初稿
- [x] 1.2 实现默认配置归一化、节点状态模型与可持久化序列化
- [x] 1.3 为配置边界和初始节点状态编写并运行失败优先测试

## 2. sing-box Clash API 客户端

- [x] 2.1 实现 `/proxies`、`/delay` 和 Selector PUT 客户端
- [x] 2.2 实现 HTTP 状态、超时、JSON 和正数 delay 响应解析
- [x] 2.3 测试 200、503、504、非 JSON、无效 delay、授权和 URL 编码

## 3. 可恢复健康状态机

- [x] 3.1 实现 healthy、suspect、cooldown、half-open 状态转换
- [x] 3.2 实现连续失败阈值、指数退避、冷却上限和恢复阈值
- [x] 3.3 测试失败节点冷却、到期半开、恢复和候选资格

## 4. Selector 监控与故障切换

- [x] 4.1 同步主 Selector 的 all/now 并识别嵌套 URLTest
- [x] 4.2 实现并发受限、不可重入的探测轮次
- [x] 4.3 实现候选选择、PUT 切换和 now 二次确认
- [x] 4.4 处理用户手动切换、无候选和 API/组异常
- [x] 4.5 测试监控轮次、切换防抖、确认失败和生命周期停止

## 5. GUI.for.SingBox 插件适配

- [x] 5.1 创建 GFS 插件源码和 Plugin-Hub 元数据
- [x] 5.2 接入 GUI.for.SingBox kernel store、配置和 data 目录 I/O
- [x] 5.3 实现 onRun、onCoreStarted、onCoreStopped、onShutdown、onDispose、onUninstall 和停止菜单
- [x] 5.4 添加状态 UI、配置项和代码审计边界测试

## 6. 集成验证与交付文档

- [x] 6.1 补充安装、配置、状态机、回滚和限制文档
- [x] 6.2 校验插件路径、元数据触发器、默认值和 README 契约
- [x] 6.3 运行全量 Node 测试与 `openspec validate --all --json`
- [x] 6.4 生成完整 diff 供用户人工审阅；不自动推送或创建 PR

## 7. 分层检测改造

- [ ] 7.1 新增真实探测间隔、真实盯梢稳定阈值、事件队列上限默认值与归一化
- [ ] 7.2 实现内存事件环形队列（recordEvent）并接入快照摘要
- [ ] 7.3 实现单飞真实探测 runRealProbe（stableKey + generation 过期丢弃）
- [ ] 7.4 将真实探测从 watchCycle 阻塞中移出，改为不阻塞 HEAD 周期的触发
- [ ] 7.5 盯梢期高延迟一次即切，盯梢只由真实 GET 达标退出
- [ ] 7.6 补/改分层检测测试并跑全量 node --test
- [ ] 7.7 同步插件适配、元数据与 README，构建并替换插件
