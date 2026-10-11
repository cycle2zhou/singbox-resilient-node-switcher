# singbox-resilient-node-switcher

面向 GUI.for.SingBox 的可恢复节点切换插件项目。

## 当前状态

Task 1 已完成项目骨架与公共模型：

- `src/config.js`：默认配置与安全归一化；
- `src/model.js`：节点健康状态创建与可持久化序列化；
- `test/`：使用 Node.js 内置测试运行器的公共模型测试。

## 默认配置

默认主 Selector 为 `🚀 节点选择`，检查间隔 30 秒、单节点超时 5 秒、并发上限 3；连续失败阈值为 3，恢复阈值为 2，初始冷却 120 秒，最大冷却 1800 秒，最短驻留 60 秒。

后续实现将仅使用 sing-box Clash API 进行主动探测和 Selector 切换，不修改生成配置、节点列表或现有用户插件。主动探测结果不等同于所有真实业务请求均已恢复；嵌套 URLTest 仍由 sing-box 核心管理。

## 测试

```sh
npm test
```
