# Task 2 报告：Clash API 客户端与响应解析

## 状态

已完成 Task 2，未修改 Task 3 及之后的实现，也未修改用户现有插件。

## TDD 记录

### RED

命令：

```sh
node --test test/response.test.js test/api.test.js
```

结果：失败，原因是模块尚不存在：

- `ERR_MODULE_NOT_FOUND`：`src/api.js`
- `ERR_MODULE_NOT_FOUND`：`src/response.js`

### GREEN

定向命令：

```sh
node --test test/response.test.js test/api.test.js
```

结果：8 个测试全部通过。

全量命令：

```sh
node --test
```

结果：13 个测试全部通过，0 失败。

## 实现内容

- `src/response.js`
  - 实现 `parseDelayResponse(status, body)`。
  - 拒绝所有非 2xx 状态。
  - 支持字符串 JSON 解析并拒绝非 JSON、缺失对象、非有限数、零和负数 `delay`。
- `src/api.js`
  - 实现 `createClashApi({baseUrl, secret, fetchImpl})`。
  - 提供 `getProxies(signal)`、`probe(node, url, timeoutMs, signal)`、`select(group, node, signal)`。
  - 所有请求携带 `Authorization: Bearer <secret>`（未设置密钥时不添加空授权头）。
  - 节点名和组名使用 URL 编码；探测 URL 和超时使用查询参数。
  - `select` 使用 `PUT` 和 JSON body `{name: node}`。
  - 探测使用组合 `AbortController` 支持调用方取消和超时，并将超时/取消/请求错误转换为失败结果。
  - 未调用 provider healthcheck。

## 提交

提交信息：`feat: add sing-box clash api client`

Task 2 实现提交哈希：`0f35865`。

本报告在实现提交之后单独补交，以避免报告内容中的哈希改变实现提交本身。

## 顾虑

- `getProxies` 和 `select` 由调用方通过 `signal` 控制取消；只有 `probe` 接收显式 `timeoutMs`，因为当前接口没有为另外两个操作定义超时参数。
- `getProxies` 在请求失败时抛出带 `ok/status/reason/body` 字段的错误，便于上层协调器记录原因；`probe` 和 `select` 返回 `{ok:false, reason}` 风格结果。
- 依赖 Node 内置 `AbortController`、`DOMException` 和 `URLSearchParams`，符合项目零第三方依赖约束。
