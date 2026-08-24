# GitHub 私有仓库同步 Plan B

> 状态：独立备选方案，待实施。
>
> 定位：使用 GitHub 私有仓库和真实 Git commit/ref 作为远程传输与历史层。该方案**不另造一套同步算法**，复用本仓库同步核心（`src/sync/`）已实现的不可变操作日志、revision DAG、冲突分支、永久删除、IndexedDB journal、逻辑 OTP 数据、AES-GCM 和本地崩溃恢复。

---

## 1. 目标与边界

### 1.1 目标

- 多台浏览器通过同一个 GitHub 私有仓库保持 Authenticator 数据一致；
- 每次远程变更形成真实 Git commit，可审计、比较和回退；
- 多设备同时提交时使用 Git ref 的原子 fast-forward 更新检测竞态；
- GitHub 只承担远程存储、提交历史和分发，不参与 OTP 业务冲突裁决；
- 不在浏览器扩展中内置完整 Git CLI。

### 1.2 与同步核心共享的规范

以下规范由传输无关的同步核心（`src/sync/` 下的 SyncCoordinator、SyncJournal、OperationReducer、SyncCrypto、LocalAccountAdapter、SyncEngine）定义，本文件不重复：

- 保证范围与 fail-closed 原则；
- `SyncCoordinator`、`SyncJournal`、`OperationReducer`、`SyncCrypto`、`LocalAccountAdapter`；
- 不可变操作、`opId + parents` revision DAG；
- 并发分支、冲突解决、永久 delete operation；
- order 独立实体、HOTP counter 单调合并；
- operation-first 本地持久化和崩溃恢复；
- 同步密码、仓库数据密钥、AES-256-GCM；
- 本地账户密码与同步加密解耦；
- 默认触发时机和同步状态机。

### 1.3 Plan B 特有约束

1. v1 只支持 **GitHub.com 私有仓库**，不支持 GitHub Enterprise Server 或任意 Git 服务；
2. v1 使用 GitHub REST Git Database API，不执行 `git clone/fetch/push`；
3. 使用专用分支 `authenticator-sync`；扩展永远不 force-push；
4. GitHub 模式 v1 **强制开启同步加密**。Git 历史长期保留旧版本，不允许把 OTP secret 明文写入 commit；
5. GitHub 是唯一的同步 transport，同一时间只能启用一个仓库；不提供双写镜像模式；
6. 切换 transport 时，未确认 outbox 必须先完成同步、导出，或由用户明确执行破坏性放弃。

---

## 2. 为什么使用 GitHub Git Database API

### 2.1 推荐路径

GitHub 官方提供 blob、tree、commit 和 ref API，可以在没有安装 Git 的情况下创建真实 Git 历史。v1 使用以下模型：

```text
GET branch ref
→ GET head commit/tree
→ POST new tree based on head tree
→ POST commit(parent = old head)
→ PATCH branch ref(force = false)
```

对于小型 JSON operation，可直接在 create-tree 请求中使用 `content`，由 GitHub 创建 blob，减少独立 create-blob 请求。

### 2.2 不采用完整浏览器 Git 客户端

`isomorphic-git` 等方案需要浏览器文件系统 adapter、对象数据库、packfile、smart HTTP、凭据和更多 CORS/兼容性处理。对于本项目只追加小型不可变 operation 的场景，Git Database API 接口更小、更容易测试。

### 2.3 Git 不负责语义合并

不得依赖以下机制处理账户冲突：

- Git 自动合并 JSON；
- “最后一个 commit 获胜”；
- 每设备独立 branch 后自动 merge；
- GitHub PR merge。

所有 OTP 冲突仍由 OperationReducer 根据 revision DAG 处理。Git commit 只是将一批不可变 operation 原子挂到分支历史。

---

## 3. 远程仓库结构

推荐用户创建专用私有仓库，不和源码、笔记或其他数据混用。

```text
branch: authenticator-sync

/AuthenticatorSync/
  config.json
  ops/
    <deviceId>/
      <opId>.json
```

文件格式与同步核心定义一致：

- `config.json`：repositoryId、协议版本、Argon2id 参数、wrapped repository data key；
- operation 文件：不可变 AES-GCM envelope；
- operation 路径只使用 UUID 和固定 ASCII 段；
- 扩展不得修改或删除已经提交的 operation；
- commit message 不包含 issuer、account、secret 或同步密码。

推荐 commit message：

```text
Authenticator sync: <operation-count> operation(s) from <device-short-id>
```

---

## 4. GitHub 身份验证

### 4.1 v1：Fine-grained Personal Access Token

v1 推荐 fine-grained PAT：

- Resource owner：私有仓库所属用户或组织；
- Repository access：`Only select repositories`，只选择同步仓库；
- Repository permission：`Contents: Read and write`；
- 不请求 Workflows、Issues、Pull requests、Administration 等权限；
- 不允许把同步目录放在 `.github/workflows/` 下。

组织可能禁止 fine-grained PAT、要求管理员审批或强制过期时间。UI 必须区分：

- token 无效；
- token 等待组织审批；
- 仓库未被授权；
- Contents 只有 read；
- token 已过期/被撤销。

### 4.2 Token 存储

提供两种选择：

- “仅本次浏览器会话”：token 存 `chrome.storage.session`；
- “记住 token”：token 存 `chrome.storage.local`，不进入浏览器 sync。

要求：

- token 不写入日志、commit、错误详情、遥测或 URL；
- 请求使用 `Authorization: Bearer <token>`；
- 断开连接时清除 token；
- UI 提示 token 等同密码，并建议设置有效期；
- 仓库重命名或 token 权限调整后需要重新验证。

### 4.3 后续可选：OAuth Device Flow

Device Flow 只需要公开 `client_id`，不需要把 `client_secret` 嵌入扩展，可作为后续改善体验的方案。

但 OAuth App 访问私有仓库通常需要账户级 `repo` scope，权限范围明显大于只授权一个仓库的 fine-grained PAT。因此：

- v1 不实现 Device Flow；
- 后续实现时必须单独取得用户批准；
- 必须遵守 GitHub 返回的轮询 interval、`slow_down` 和 token 刷新规则；
- 不能在客户端代码中嵌入 client secret。

---

## 5. Manifest 与网络权限

GitHub transport 只需要固定域名：

```jsonc
{
  "optional_host_permissions": ["https://api.github.com/*"]
}
```

CSP `connect-src` 至少包含：

```text
https://api.github.com/
```

现有 `connect-src https:` 可以覆盖 GitHub API；运行时仍应只申请实际启用 transport 所需的 host permission。

Device Flow 后续还需访问 GitHub 登录端点，v1 PAT 模式不需要。

---

## 6. 仓库与分支初始化

### 6.1 用户输入

设置页要求：

- GitHub owner；
- repository name；
- fine-grained PAT；
- 同步密码；
- 是否记住 token。

也可以接受 GitHub repository URL，但解析后只保存 owner/repo，不保存 URL 中任何凭据或 fragment。

### 6.2 仓库校验

连接前验证：

1. 仓库存在且 `private=true`；公共仓库直接拒绝；
2. token 对仓库具有 Contents read/write；
3. 仓库不是空仓库，或用户明确允许扩展通过 Contents API 创建初始文件；
4. 专用分支不受阻止扩展 fast-forward 更新的 branch protection/ruleset 限制；
5. 仓库默认分支和专用分支状态可读取；
6. API rate-limit 尚可完成初始化。

### 6.3 空仓库

GitHub 不允许在完全没有 branch 的空仓库中直接创建 ref。v1 提供两种路径：

- 推荐：用户创建私有仓库时勾选 Initialize with README；
- 可选：经用户确认后，扩展使用 Repository Contents API 创建一个初始化文件，再进入 Git Database API 流程。

扩展不自动创建 GitHub repository，避免额外 Administration 权限。

### 6.4 创建专用分支

若 `refs/heads/authenticator-sync` 不存在：

1. 读取默认分支 head SHA；
2. 使用 `POST /git/refs` 从该 SHA 创建 `refs/heads/authenticator-sync`；
3. 若其他设备抢先创建而返回 409/422，重新读取该分支并继续；
4. 分支创建后，所有同步操作只更新该分支。

### 6.5 初始化 config

1. 读取专用分支当前 head/tree；
2. 若 `AuthenticatorSync/config.json` 不存在，生成 config 和初始 tree/commit；
3. 使用 `force:false` 更新 ref；
4. 若 ref 更新失败且 head 已变化，重新读取新 head：
   - 如果 config 已由另一设备创建，验证 repositoryId、加密模式与同步密码后加入；
   - 如果 config 仍不存在，基于新 head 重建 commit 后重试；
5. config 已存在时不得覆盖；内容变化视为仓库被替换或篡改，fail-closed。

初始化完成后按同步核心的“首次数据播种”规则创建 root operations。

---

## 7. 拉取流程

### 7.1 快速无变化检查

本地保存：

- 上次成功同步的 branch head SHA；
- ref/tree GET 的 ETag；
- 已知 operation 路径与 blob SHA；
- repositoryId/config fingerprint。

同步时对 branch ref 使用 `If-None-Match`：

- `304 Not Modified`：远程无变化，且该请求不计入 GitHub primary rate limit；
- `200` 且 head 改变：进入 tree 枚举；
- 401/403/404：进入对应错误状态，不把它视为空仓库。

### 7.2 Tree 枚举

1. GET head commit，取得 tree SHA；
2. 优先读取 `AuthenticatorSync/` 子树，而不是扫描无关目录；
3. 可使用 recursive tree 快速获取操作列表；
4. 若响应 `truncated=true`，必须退回非递归逐层读取：
   - `AuthenticatorSync/`；
   - `ops/`；
   - 每个 `ops/<deviceId>/`；
5. 不允许把 truncated tree 当成完整仓库；
6. 与本地已知 path/blob SHA 比较，只下载未知或变化文件。

正常情况下旧 operation 的 blob SHA 不得变化。已知路径内容变化或消失时进入 `remoteRewritten/remoteCorrupt`，不得直接接受。

### 7.3 下载与应用

- 使用 blob API 读取 operation；
- 先做大小、repositoryId、路径、formatVersion 预校验；
- 原始字节写入 IndexedDB inbox；
- 再执行 AES-GCM、AAD、contentHash、parents 和 payload 校验；
- 按共享 OperationReducer 重新归约；
- 经单写者 mutex 应用到本地账户存储；
- 更新已知 head/tree/blob SHA 和同步状态。

---

## 8. 提交流程

### 8.1 批处理

本地变更后仍防抖 5 秒。一个 commit 可以包含多个 pending operation，减少 API 调用。

建议初始限制：

- 每 commit 最多 50 个 operation；
- 每 commit 总正文不超过 1 MiB；
- 超过限制分批串行提交；
- 具体阈值在 G0 实测后调整。

### 8.2 原子提交步骤

每一批执行：

1. GET `refs/heads/authenticator-sync`，记录 `headSha`；
2. GET head commit，取得 `baseTreeSha`；
3. POST `/git/trees`：
   - `base_tree = baseTreeSha`，保证未列出的文件继续保留；
   - 每个新 operation 添加 `path/mode=100644/type=blob/content`；
   - 已存在 operation 路径不得修改；
4. POST `/git/commits`：
   - `tree = newTreeSha`；
   - `parents = [headSha]`；
   - commit message 不含账户内容；
5. PATCH branch ref：
   - `sha = newCommitSha`；
   - `force = false`；
6. 重新读取 ref/tree，确认本批 operation path/blob SHA 已进入当前分支；
7. 确认后才把 outbox 标记为 remote-acknowledged。

### 8.3 多设备竞态

设备 A、B 同时基于 head H 创建 commit：

- A 先 fast-forward 成功；
- B 更新 ref 时收到 409 或 422；
- B 必须重新读取最新 head/tree；
- 如果 B 的 operation 已经出现，视为幂等成功；
- 否则以新 head 为 parent、以新 head tree 为 base_tree 重新创建 commit；
- 永远不使用 `force:true`。

不能只根据 409/422 判断竞态：若 ref head 未变化，应把响应视为真实验证、权限、ruleset 或滥用限制错误并展示。

### 8.4 响应丢失和 dangling commit

- commit 创建成功但 ref 更新失败：产生无法从 branch 到达的 dangling commit，不影响同步；重试时基于最新 head 创建新 commit；
- ref 更新成功但响应丢失：重新 GET ref/tree；operation 已存在则视为成功；
- outbox 原始 envelope 字节和 opId 必须重放，不能重新生成同 opId 内容；
- GitHub 对 Git 对象的后台清理不属于同步协议的一部分，不依赖 dangling commit 做恢复。

### 8.5 禁止修改历史

扩展不得执行：

- `force:true` 更新 ref；
- 删除 `authenticator-sync` branch；
- rebase、squash 或覆盖旧 commit；
- 修改/删除已提交 operation；
- 使用 GitHub Contents API 覆盖同步目录中的已有 operation。

用户手工 force-push、删除 branch 或修改旧 operation 时进入 `remoteRewritten`，需要明确的恢复流程。

---

## 9. GitHub 特有的错误与恢复

### 9.1 状态

在公共同步状态机上增加：

- `githubTokenRequired`
- `githubTokenExpired`
- `githubRepoNotFound`
- `githubPermissionInsufficient`
- `githubApprovalPending`
- `githubRateLimited`
- `githubBranchProtected`
- `githubBranchDiverged`
- `remoteRewritten`

### 9.2 branch 被重写

检测方式：

- 新 head/tree 缺少本地已确认的 operation；
- 已知 operation path 对应不同 blob SHA；
- config fingerprint/repositoryId 改变。

处理：

1. 停止自动提交；
2. 保留本地完整 journal/outbox；
3. 展示缺失和变化的文件数量；
4. 用户可选择把本地已知 operation 重新提交到当前 head，或断开并忘记仓库；
5. 不自动把远程重写解释为合法删除。

设备无法发现“在它第一次连接前已经被删除且所有现存副本都没有保存”的历史，这是 GitHub 管理员/用户破坏远程历史后的残余风险。

### 9.3 仓库重命名或转移

- 404 不等于空仓库；
- 用户必须重新输入 owner/repo 并验证 repositoryId；
- repositoryId 相同才允许延续原 journal；
- repositoryId 不同按共享方案的仓库切换规则处理，禁止混用 outbox。

---

## 10. 加密与隐私

### 10.1 强制端到端加密

GitHub Plan B v1 不提供“不加密”选项：

- private repository 仍由 GitHub 托管；
- Git commit 历史会长期保留旧内容；
- 删除当前文件不会自动清除历史 blob；
- 因此 operation 和 config 中的敏感 payload 必须使用共享方案的 AES-GCM envelope。

GitHub 能看到：

- 仓库与分支存在；
- operation 文件数量；
- deviceId 目录；
- commit 时间和频率；
- 加密文件大小。

GitHub 不能从密文直接获得 issuer、account、secret 或冲突内容。

### 10.2 Token 与同步密码分离

- PAT 只用于 GitHub API；
- 同步密码只用于解包 repository data key；
- PAT 泄漏允许攻击者读取/修改私有仓库，但不能直接解密 AES-GCM payload；
- 同步密码泄漏但没有仓库访问权限时不能直接下载数据；
- 两者均泄漏时数据保密性失效。

### 10.3 手工查看和修改

README 明示：用户可以在 GitHub 查看 commit 历史，但不应手工编辑 `AuthenticatorSync/`。手工修改 operation 或 config 会触发 fail-closed。

---

## 11. API 配额与性能

### 11.1 Primary rate limit

认证用户通常为 5,000 requests/hour，且与该用户其他 PAT/OAuth/GitHub App user-token 请求共享预算。

每次响应读取：

- `x-ratelimit-limit`
- `x-ratelimit-remaining`
- `x-ratelimit-used`
- `x-ratelimit-reset`

ref/tree polling 使用 ETag 和 `If-None-Match`；正确授权请求返回的 304 不计入 primary rate limit。

### 11.2 Secondary rate limit

必须处理：

- 403/429；
- `retry-after`；
- 写操作 points 更高；
- content-generating request 限制；
- 并发请求限制。

策略：

- 所有写入串行；
- 5 秒防抖并批量 commit；
- 收到 `retry-after` 时严格等待；
- 没有 retry-after 时指数退避并加随机抖动；
- rate limited 时保持 durable pending，不丢 operation；
- 不通过循环轮询 `/rate_limit` 规避 secondary limits。

### 11.3 Tree 和 blob 限制

- recursive tree 超过 100,000 entries 或约 7 MB 可能返回 `truncated=true`；必须逐子树读取；
- blob API 实际上限远高于本项目 operation 大小，但本地仍限制单 operation 和总批次大小；
- 达到 operation 数量/仓库体积阈值时 UI 提醒用户；未来可复用同步核心的不可变 snapshot 方案优化新设备启动。

---

## 12. UI 方案

### 12.1 GitHub 设置页

字段：

- Owner
- Repository
- Fine-grained PAT
- 同步密码
- 记住 token

操作：

- 测试权限
- 创建/连接 `authenticator-sync` branch
- 立即同步
- 断开连接
- 忘记此仓库
- 打开 GitHub 仓库

### 12.2 状态展示

除公共状态外显示：

- 当前 owner/repo/branch；
- 当前 head commit 短 SHA；
- 上次成功 pull/push 时间；
- pending operation 数；
- 当前 API rate-limit remaining/reset；
- token 类型与是否会话存储；
- branch 重写、保护规则、权限不足等错误。

UI 和日志永远不显示完整 PAT。

---

## 13. 代码结构

共享同步核心不变，新增 transport adapter：

```text
src/sync/transports/GitHubGitAdapter.ts
src/sync/github/GitHubAuth.ts
src/sync/github/GitHubApiClient.ts
src/sync/github/GitHubTreeReader.ts
src/sync/github/GitHubCommitWriter.ts
src/components/Popup/GitHubSyncPage.vue
```

推荐 transport seam：

```ts
interface SyncTransport {
  connect(): Promise<RemoteRepositoryInfo>;
  listUnknownOperations(known: KnownRemoteState): Promise<RemoteDelta>;
  uploadOperations(batch: ImmutableOperationFile[]): Promise<UploadReceipt>;
  getHealth(): Promise<TransportHealth>;
  disconnect(): Promise<void>;
}
```

`GitHubGitAdapter` 实现该 interface；OperationReducer 不感知远程类型。

新增设置全部只存 local/session：

```text
syncProvider = "github"
githubOwner
githubRepository
githubBranch = "authenticator-sync"
githubRememberToken
githubLastHeadSha
githubLastEtag
```

PAT 根据用户选择存 session 或 local，绝不进入 sync storage。

---

## 14. 实施阶段

| 阶段                     | 内容                                                                                                             | 验收                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **G0 GitHub API 原型**   | scratch 私有仓库验证 PAT 权限、空仓库、branch 创建、tree/commit/ref、non-fast-forward 409/422、ETag/304、ruleset | 官方文档与实际响应矩阵；从不 force-push     |
| **G1 GitHub API client** | Auth、条件 GET、错误映射、rate-limit、tree 截断 fallback                                                         | mock 单测 + scratch repo 集成测试           |
| **G2 GitHub transport**  | 批量 operation tree、commit、ref CAS 重试、响应丢失确认、branch 重写检测                                         | 两客户端同时提交不丢 operation              |
| **G3 同步核心集成**      | 实现 SyncTransport seam，接入 journal/reducer/crypto                                                                            | GitHub 与同步核心共用同一 reducer 测试集       |
| **G4 UI 与凭据**         | GitHubSyncPage、PAT、权限检查、状态、断开/忘记流程                                                               | token 不出现在日志/commit；错误状态可操作   |
| **G5 跨端验证**          | Chrome/Firefox/Edge、多 profile、离线、限流、token 过期、branch 重写                                             | 真实私有仓库 E2E；构建/tsc/eslint/test 全绿 |

---

## 15. 必须覆盖的测试

### 15.1 初始化

- 私有非空仓库；
- 完全空仓库；
- 专用 branch 不存在/已存在；
- 两设备同时创建 branch/config；
- config 已存在且同步密码正确/错误；
- 公共仓库必须拒绝。

### 15.2 并发提交

- 两设备基于同一 head 提交不同 operation；
- ref 更新返回 409/422 后重基于新 head；
- commit 成功但 ref 失败；
- ref 成功但响应丢失；
- 同一 operation 已由另一设备提交；
- `force` 始终为 false。

### 15.3 Pull 与历史

- ETag/304 无变化；
- recursive tree 正常和 truncated fallback；
- 已知 operation 缺失、内容变化；
- branch force-push、删除、重建；
- 仓库重命名/转移；
- dangling commit 不影响状态。

### 15.4 认证和配额

- PAT 正确、过期、撤销、read-only、未批准；
- 401/403/404/409/422/429/5xx；
- primary remaining 接近零；
- secondary limit + retry-after；
- session token 在浏览器重启后消失；
- local token 不进入浏览器 sync。

### 15.5 安全

- operation/config 始终为 AES-GCM 密文；
- commit message/path 不包含账户元数据；
- PAT 不出现在日志、异常、URL 或 Git 内容；
- 手工修改 config/operation 时 fail-closed；
- 公共仓库、跨 transport outbox、不同 repositoryId 均禁止自动合并。

---

## 16. 发布门槛

1. scratch repo 实测 non-fast-forward 的真实状态码和错误体；
2. 两台、三台浏览器同时提交无 operation 丢失；
3. 所有 ref 更新明确 `force:false`；
4. 响应丢失和 dangling commit 流程可恢复；
5. branch 重写/operation 修改全部 fail-closed；
6. API 限流不会丢弃 pending operation；
7. fine-grained PAT 只需目标仓库 `Contents: Read and write`；
8. 私有仓库与 AES-GCM 强制检查不能绕过；
9. GitHub transport 与同步核心使用同一 OperationReducer 和崩溃恢复测试集；
10. README/SECURITY 清楚解释 PAT、GitHub 元数据可见性、Git 历史永久性和同步密码不可恢复。

---

## 17. 官方资料

- [Using the REST API to interact with your Git database](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database)
- [REST API endpoints for Git blobs](https://docs.github.com/en/rest/git/blobs)
- [REST API endpoints for Git trees](https://docs.github.com/en/rest/git/trees)
- [REST API endpoints for Git commits](https://docs.github.com/en/rest/git/commits)
- [REST API endpoints for Git references](https://docs.github.com/en/rest/git/refs)
- [REST API endpoints for repository contents](https://docs.github.com/en/rest/repos/contents)
- [Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Authorizing OAuth apps — Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
- [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [Keeping API credentials secure](https://docs.github.com/en/rest/authentication/keeping-your-api-credentials-secure)
