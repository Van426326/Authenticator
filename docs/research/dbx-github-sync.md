# DBX 的 GitHub 加密配置同步实现

> 调研对象：[`t8y2/dbx`](https://github.com/t8y2/dbx)；结论固定到提交 [`d7c81195d9586ff300360e5134452fbbf3a5c788`](https://github.com/t8y2/dbx/tree/d7c81195d9586ff300360e5134452fbbf3a5c788)（2026-08-24 拉取的 `main`）。本文只描述 DBX，供与本项目实现逐项对比。

## 结论摘要

DBX 的“同步到 GitHub”并不是向普通 GitHub 仓库提交文件，而是通过 GitHub REST API 手动上传/下载一个 **secret Gist**。远端 Gist 内只有一个 `dbx-sync.json` 文件；当前实现要求用独立的“代码片段加密密码”对完整同步快照做 Argon2id + AES-256-GCM 加密。数据库密码等敏感项默认不进入快照，也可以用第二个独立密码加密后嵌入快照，再由外层整体加密。[产品文档](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/docs/content/docs/cloud-sync.mdx#L12-L29)；[快照与加密结构](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L23-L198)

同步模型是手动的整快照覆盖：没有增量记录、三方合并、设备版本向量或远端条件写。普通上传是 `GET` 当前 Gist、用输入密码验证其可解密，然后 `PATCH`；这个验证避免意外换密码，却不能避免两个设备同时写入，最终是 last-write-wins。DBX 文档也明确说明“不合并并发修改，上传前先下载”。[上传实现](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L646-L745)；[并发语义文档](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/docs/content/docs/cloud-sync.mdx#L130-L132)

## 调用链

### 上传

```text
EditorSettingsDialog.uploadSnippetSnapshot()
  -> frontend snippetSyncUpload()
  -> Tauri invoke("snippet_sync_upload")
  -> command snippet_sync_upload()
       -> resolve_snippet_token()
       -> build_sync_snapshot()
       -> SnippetSyncClient.put_snapshot()
       -> finalize_snippet_migration()
  -> GitHub GET /gists/{id} + PATCH /gists/{id}
     或首次创建 POST /gists
```

- UI 收集 provider、token、Gist ID、外层密码、是否携带凭据以及内层凭据密码；上传成功后保存返回的 Gist ID。[UI](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/apps/desktop/src/components/editor/EditorSettingsDialog.vue#L2063-L2093)；[上传动作](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/apps/desktop/src/components/editor/EditorSettingsDialog.vue#L2181-L2217)
- TypeScript 桥接层只把参数传给 Tauri 命令。[桥接代码](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/apps/desktop/src/lib/backend/tauri.ts#L786-L797)
- 命令层解析已保存 token、校验可选凭据密码、构造快照，然后调用 Gist 客户端；旧明文迁移还会进入收尾清理。[Tauri 命令](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/src-tauri/src/commands/cloud_sync.rs#L195-L220)

### 下载与应用

```text
EditorSettingsDialog.downloadSnippetSnapshot()
  -> frontend snippetSyncDownload()
  -> Tauri invoke("snippet_sync_download")
  -> command snippet_sync_download()
       -> resolve_snippet_token()
       -> SnippetSyncClient.get_snapshot()
       -> parse_snippet_snapshot()
       -> apply_sync_snapshot()
  -> 前端重新加载连接、保存的 SQL、隧道和 AI 配置
```

下载会解密并反序列化完整快照，再替换本地连接元信息、保存的 SQL 和设置。默认不恢复远端凭据，因此会保留本机凭据；只有显式启用 `restoreSecrets` 且提供正确的内层密码时才清理并写入远端凭据。[应用逻辑](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L297-L345)；[下载命令](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/src-tauri/src/commands/cloud_sync.rs#L223-L244)；[UI 刷新](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/apps/desktop/src/components/editor/EditorSettingsDialog.vue#L2234-L2245)

## GitHub 远端协议

| 场景 | 请求 | 语义 |
| --- | --- | --- |
| 测试、未填 ID | `GET https://api.github.com/user` | 验证 token |
| 测试/读取、已填 ID | `GET /gists/{id}` | 验证访问或读取 `dbx-sync.json` |
| 首次上传 | `POST /gists` | 创建 `public: false` 的 Gist |
| 更新 | `PATCH /gists/{id}` | 整体替换目标文件内容 |
| 旧明文清理 | `DELETE /gists/{id}` | 仅安全迁移流程使用 |

GitHub 请求带 `Accept: application/vnd.github+json`、`User-Agent: DBX`、`X-GitHub-Api-Version: 2022-11-28` 和 Bearer token。创建/更新 JSON 为：

```json
{
  "description": "DBX encrypted configuration sync",
  "public": false,
  "files": {
    "dbx-sync.json": {
      "content": "<加密信封 JSON 字符串>"
    }
  }
}
```

这些端点、header 和请求体均集中在 `SnippetSyncClient`。[客户端实现](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L622-L835)

DBX 文档推荐 fine-grained PAT 的 Account permissions / Gists: Read and write，或 classic PAT 的最小 `gist` scope，不要求仓库权限。[DBX 授权文档](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/docs/content/docs/cloud-sync.mdx#L32-L54)

需要注意 GitHub 的产品术语：`public: false` 创建的是 **secret Gist**，不出现在 Discover，普通搜索也找不到；它不是本项目若使用 private repository 时的仓库访问控制模型。[GitHub 官方 Gist 文档](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists)

## 远端载荷格式

Gist 文件的顶层不是 `SyncSnapshot` 明文，而是下面的加密信封：

```json
{
  "format": "dbx-encrypted-sync-snapshot",
  "version": 1,
  "payload": {
    "version": 1,
    "kdf": "argon2id",
    "cipher": "aes-256-gcm",
    "salt": "<Base64>",
    "nonce": "<Base64>",
    "ciphertext": "<Base64>"
  }
}
```

解密后的 `SyncSnapshot` 是 camelCase JSON，包含：

- `schemaVersion`、`exportedAt`、`appVersion`；
- 已清除秘密字段的连接配置；
- MQTT 订阅、共享隧道元信息；
- 侧边栏布局、固定节点、保存的 SQL；
- desktop/editor settings；
- 可选的 `encryptedSecrets` 内层加密块。

类型定义与构造过程见 [快照类型](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L108-L198) 和 [快照构建](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L243-L279)。

普通连接对象无论是否启用凭据同步都会先清空数据库密码、SSH/代理/HTTP 隧道秘密、Redis Sentinel 密码、连接串、初始化脚本及 MQ/Nacos 认证字段。因此不携带凭据的快照不是“把秘密留在明文内层再依赖外层”，而是真正从快照数据模型中移除或置空。[清理逻辑](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L950-L972)

启用凭据同步时，`SensitiveSyncPayload` 收集允许持久化的连接秘密、AI 配置以及带秘密的完整隧道 profile，经第二个密码加密为 `encryptedSecrets`；随后整个 `SyncSnapshot` 再被外层密码加密。也就是说远端可以有两层相互独立的密码保护。[敏感载荷构建](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L996-L1057)；[双层加密入口](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L1273-L1306)

## 加密、KDF 与密钥处理

两层加密以及本机 token 加密共用同一套原语：

| 项目 | DBX 参数 |
| --- | --- |
| KDF | Argon2id，version 0x13 |
| memory | `19 * 1024` KiB（19 MiB） |
| iterations | 2 |
| parallelism | 1 |
| 输出密钥 | 32 bytes |
| cipher | AES-256-GCM |
| salt | `OsRng` 随机 16 bytes |
| nonce | `OsRng` 随机 12 bytes |
| 编码 | 标准 Base64 |

每次加密都生成新 salt 和 nonce。AES-GCM 同时提供机密性和认证完整性；代码未传入额外 AAD。格式版本、KDF/cipher 名称、salt 和 nonce 是明文，快照主体在 ciphertext 中。[具体实现](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L1373-L1413)

### 三类秘密的生命周期

1. **外层代码片段密码**：上传必填；下载加密 Gist 时必填。它只在 UI 内存状态和命令参数中传递，没有保存接口。[密码校验](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L1441-L1449)
2. **可选内层凭据同步密码**：与外层密码独立，仅在用户选择上传/恢复凭据时使用；Gist 路径不会保存这个密码。DBX 文档明确两种密码均不上传且不可找回。[同步密码文档](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/docs/content/docs/cloud-sync.mdx#L91-L105)
3. **GitHub PAT**：可只在当前表单使用，也可选择记住。本地保存时先用 `local_device_secret` 经过同一 Argon2id + AES-GCM 流程加密，再把密文写入 app settings。[token 保存/解析](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L391-L480)

本地 token 保护存在一个明确边界：`local_device_secret` 是随机 UUID，但它本身也以明文放在同一份 app settings JSON 中，token 密文也在该 settings 的 `webdav_passwords` 对象里。由此推断，这可以避免 token 直接以明文出现，但不能抵抗能够读取整份 DBX 本地存储的攻击者；它不是 OS Keychain/Secret Service 的硬边界。[本机 secret 与密文存储](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/storage.rs#L1862-L1890)

## 冲突、版本和迁移语义

### 普通并发更新

- 已有加密 Gist：先 `GET`，确认输入的外层密码能解密当前内容，再 `PATCH`。这防止用户无意中用新密码覆盖并锁死其他设备。[更新保护](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L654-L705)
- 代码没有使用 Gist revision、ETag、`If-Match`、远端内容 hash 或 generation 做条件更新。两个设备都通过读取校验后仍可互相覆盖，后写者获胜。
- `exportedAt` 和 `appVersion` 只进入快照/返回 summary，未参与新旧判断。`schemaVersion` 当前必须精确等于 1，否则拒绝应用。[schema 校验](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L297-L304)
- 下载是整快照替换而非 merge；没有实体 tombstone、操作日志或字段级冲突。默认保留本机秘密只是秘密字段的特殊策略，不是一般冲突合并。

### 旧明文 Gist 迁移

DBX 特别处理了历史明文快照，因为在原 Gist 上 `PATCH` 加密内容仍会把明文留在 revision history：

1. 读取旧 Gist，检查稳定的 DBX 标记字段，并确保能解析成兼容快照；任意非 DBX Gist 都拒绝覆盖/删除。
2. 加密的是刚读到的**远端旧快照**，不是当前设备可能过时的本地状态。
3. `POST` 新 Gist，不原地 `PATCH` 旧 Gist。
4. 先持久化新 Gist ID、旧 Gist ID 和旧内容 SHA-256，再重新读取旧 Gist。
5. 只有内容 hash 未变才删除旧 Gist；否则保留待人工清理状态，可重启后重试。

[迁移上传](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L646-L745)；[删除前复核](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L789-L810)；[识别与准备旧快照](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L1315-L1362)；[迁移状态持久化](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/storage.rs#L1953-L2005)

这个迁移保护仍是“读取后再删除”的应用层检查，不是原子 conditional DELETE。若旧 Gist 恰好在第二次读取之后、DELETE 之前改变，理论上仍有 TOCTOU 窗口；源码注释也说明 provider 没有条件删除接口。[删除实现](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L789-L810)

## 安全性质与限制

### 已具备

- 完整快照外层 AEAD 加密，Gist URL 泄漏不会直接暴露连接元信息、SQL 和设置。
- 随机 salt + Argon2id 降低预计算攻击效果；随机 nonce 避免同密钥下固定 nonce。
- AES-GCM 能检测 ciphertext 篡改或错误密码。
- 敏感字段默认根本不进入内层快照；恢复秘密需要显式选择。
- 普通更新前验证旧内容密码，旧明文迁移不原地覆盖且有“新副本先落地、旧副本后删除”的恢复路径。
- PAT 只发给 GitHub API，不进入 `dbx-sync.json`；文档引导最小 Gist 权限。

### 不具备或仍需关注

- **离线口令猜测**：salt、KDF 参数和 ciphertext 都在 Gist 中，攻击者可离线试密码；安全性仍取决于用户密码熵和 KDF 成本。
- **无回滚保护**：任意历史上有效的旧密文仍可被重新放回 Gist 并成功解密；没有签名的单调版本、可信时间或设备身份。
- **无并发写保护**：GET 后 PATCH 不带条件，last-write-wins；`exportedAt` 不参与仲裁。
- **secret Gist 不是 private repository**：Gist ID/URL 是重要访问线索；即便主体加密，GitHub 仍可观察 Gist、文件名、描述、大小、修订和时间元数据。
- **本机记住 PAT 的保护有限**：加密 key 与 ciphertext 同库存放，不能替代系统凭据库。
- **截断文件下载会把 PAT 带到 API 返回的 URL**：当 Gist API 将文件标记为 `truncated` 时，DBX 读取响应中的 `raw_url`，再复用统一请求构造器；该构造器会添加 Bearer token，且代码没有校验 `raw_url` 的 host。正常 GitHub 响应指向 GitHub 控制的 raw host，但客户端自身没有建立 allow-list 边界。[raw URL fallback](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L769-L783)；[认证请求构造](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L822-L833)
- **PAT 被盗的影响**：攻击者可读取、覆盖或删除 Gist，造成泄漏密文或拒绝服务；没有外层密码时通常不能生成能被用户接受且解密成功的新快照，但可以回放已存在的合法旧密文。
- **恢复是破坏性替换**：确认框是主要的人机保护；应用过程不是一个跨所有本地存储项的显式事务，源码显示为一系列顺序写入，因此中途错误可能留下部分应用状态（这是从调用顺序得出的推论）。[应用顺序](https://github.com/t8y2/dbx/blob/d7c81195d9586ff300360e5134452fbbf3a5c788/crates/dbx-core/src/cloud_sync.rs#L317-L345)

## 与本项目对比时的关键检查项

| 维度 | DBX 基线 |
| --- | --- |
| GitHub 载体 | secret Gist，不是 repository contents/commit |
| 触发方式 | 手动 upload/download |
| 数据粒度 | 整份快照 |
| 远端内容 | 完整快照强制外层加密 |
| 凭据默认值 | 不同步；可选第二层密码加密同步 |
| KDF/cipher | Argon2id + AES-256-GCM |
| 远端并发 | 无 CAS，last-write-wins |
| 本地恢复 | 元信息/SQL/设置替换；秘密可选择保留或恢复 |
| token | PAT；可选本地加密保存，但 key 与密文同存 |
| 版本 | envelope v1 + snapshot schema v1；无迁移注册表或远端新旧仲裁 |
| 历史明文迁移 | 新建加密 Gist，再 hash 复核并删除旧 Gist |

对比本项目时，最值得优先确认的是：是否使用 repository 而非 Gist、是否利用 Git blob/commit SHA 做 CAS、是否整份加密、是否将同步密码与 PAT 分层、是否用系统凭据库保存 PAT、下载是否事务化，以及是否存在可验证的回滚/并发冲突提示。
