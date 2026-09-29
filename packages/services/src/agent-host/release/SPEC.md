# macOS 本机发布演练

验收平台只有 macOS 本机。Supervisor 仍是现有 launchd。本目录不实现、不删除、不改写其他平台的服务注册。

状态所有者：

- 原生会话文件的字节由这次演练的备份拥有。回滚只覆盖该文件。
- 外部会话只写独立 sidecar。分类仍走现有 `readLegacyZCodeSession`，不另做一套身份规则。
- prompt 是否可再派发仍由现有 `CommandJournal` 决定。演练不保存第二份已接受队列。

事件顺序：

```text
临时目录（必须在 os.tmpdir 下）
  → 只读校验已有原生记录
  → 先写备份
  → 外部会话写入 sidecar（已有 metadata schemaVersion 1）
  → 原生文件字节不变
回滚
  → 用备份覆盖原生文件
  → 旧程序只重放分类为 native 的记录
断线
  → 关闭 journal，不把活动改成 succeeded
  → 再次打开后未完成 send 是 execution-unknown，同一 prompt 不再派发
删除进行中
  → 拒绝新会话
  → 已有会话和目录保留
```

不变量：缺少 sidecar 的记录会被旧程序当成原生 zcode。因此外部会话不能写入原生文件。不新增 schema 字段。不读取用户主目录、日常会话或凭据。不创建 SSH daemon。临时目录里的逻辑可以在 CI 上跑，这不是其他平台的验收。
