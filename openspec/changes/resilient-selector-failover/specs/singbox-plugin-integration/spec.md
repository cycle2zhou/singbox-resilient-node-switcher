## ADDED Requirements

### Requirement: GUI.for.SingBox 专用集成
插件 SHALL 只使用 GUI.for.SingBox 暴露的插件 API、kernel store 和 sing-box Clash API，不包含 GUI.for.Clash 分支或其他内核控制面分支。

#### Scenario: 核心就绪
- **WHEN** GUI.for.SingBox 核心已启动且 API 可访问
- **THEN** 插件从当前 profile 的 `experimental.clash_api` 解析控制面地址和密钥并开始监控

#### Scenario: 核心未运行
- **WHEN** 核心停止或 `/version` 不可访问
- **THEN** 插件停止监控请求，不执行节点切换，并显示核心不可用原因

### Requirement: 生命周期资源清理
插件 SHALL 在核心停止、插件停用、卸载、销毁和关闭时停止定时器、取消未完成请求并释放自定义 UI 或运行状态。

#### Scenario: 核心停止
- **WHEN** GUI 触发核心停止钩子
- **THEN** 插件不再发起下一轮探测或切换请求

#### Scenario: 插件卸载
- **WHEN** GUI 触发插件卸载
- **THEN** 插件删除自身 data 缓存并不修改或删除 sing-box 配置、节点和系统代理设置

### Requirement: 可配置与可审计状态
插件 SHALL 提供检测间隔、探测超时、并发上限、失败阈值、恢复阈值、冷却上下限、最短驻留时间、探测 URL、真实探测间隔、真实延迟阈值、真实盯梢稳定阈值和主 Selector 名称配置；状态记录 SHALL 存放在 GUI data 目录且代码明文可审计。

#### Scenario: 配置读取
- **WHEN** 用户保存有效配置
- **THEN** 后续监控轮次使用新值，并对非法值应用安全边界或拒绝保存

#### Scenario: 状态展示
- **WHEN** 用户打开插件状态界面
- **THEN** 可看到当前 Selector、当前节点、节点状态、最近延迟、连续失败/成功次数、冷却截止时间和最近错误原因

### Requirement: 事件时间线诊断
插件 SHALL 在内存中维护最近 N 条探测/判定/切换事件环形队列，每条至少包含事件时间、节点稳定身份、结果、耗时、是否过期/跳过和切换原因；详细事件 MUST 仅保存在内存，持久化状态只保留聚合计数与最近摘要，不逐条写入磁盘。

#### Scenario: 记录关键事件
- **WHEN** 发生真实探测开始、真实探测结果、切换判定或切换执行
- **THEN** 插件向内存事件队列追加一条带时间戳和稳定身份的事件，超出 N 条时淘汰最旧事件

#### Scenario: 事件不逐条持久化
- **WHEN** 插件周期性写入 state 文件
- **THEN** 写入内容只含聚合计数和最近摘要，不含完整逐条事件时间线
