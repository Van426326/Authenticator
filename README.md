# Modern Authenticator

一个面向 Chrome、Firefox 与 Edge 的社区维护型双因素验证码扩展，基于开源项目 [Authenticator Extension](https://github.com/Authenticator-Extension/Authenticator) 改造。

本分支专注于更现代的界面、更直接的交互方式和更低的运行开销，不代表上游项目，也不与上游浏览器商店版本或维护团队存在官方隶属关系。

## 特性

- 在浏览器本地生成 TOTP、HOTP、Steam 和 Battle.net 验证码
- 现代化亮色、暗色与高对比度界面
- 首页一键切换亮色/暗色主题
- 窄、默认、宽三档扩展宽度
- 通过账户卡片拖拽手柄直接调整顺序
- 扫描二维码、手动输入密钥或导入备份
- 可选本地密码加密、自动锁定和 GitHub 私有仓库多设备同步
- 针对 OTP 刷新、搜索和生产构建的性能优化

## 从源码安装

### 环境要求

- Node.js 20 或更高版本
- npm
- Git

构建脚本可直接在 Windows Command Prompt、PowerShell、Linux 和 macOS 中运行；Windows 不需要额外安装 Bash 或 WSL。

### Chrome

```bash
git clone https://github.com/Van426326/Authenticator.git
cd Authenticator
git switch modern-ui-performance
npm ci
npm run chrome
```

随后打开 `chrome://extensions/`：

1. 开启“开发者模式”。
2. 点击“加载已解压的扩展程序”。
3. 选择项目生成的 `chrome/` 目录。

开发版与其他 Authenticator 扩展拥有独立的浏览器存储。迁移前请先导出备份，并妥善保存恢复文件。

## 开发与测试

```bash
# 类型检查和代码检查
npx tsc --noEmit
npx eslint . --ext .js,.ts

# 浏览器自动化测试
npm test

# 各平台构建
npm run chrome
npm run firefox
npm run edge
```

```bash
npm run prod
```

## GitHub 私有仓库同步安全说明

- 同步仅支持 **GitHub 私有仓库**，不支持公共仓库、GitHub Enterprise Server 或其他 Git 服务。
- 仓库必须为**已初始化的非空私有仓库**（例如创建时勾选 Initialize with README），扩展不会自动创建仓库。
- 扩展仅使用固定分支 `authenticator-sync`，从不 force-push；正常同步只追加不可变操作文件。
- 旧版本曾可能把操作写入错误的设备目录。只有用户在 `historyRewritten` 状态下明确确认“修复旧版操作路径”后，扩展才会创建一个非强制修复 commit：将完全相同的 Git blob 归档到 `AuthenticatorSyncLegacy/`，恢复到加密 envelope 认证过的设备路径，并从当前活动树移除错误路径；旧 commit 和原始字节仍永久保留。
- 使用 **fine-grained PAT**：Resource owner 选择同步仓库，Repository permission 仅授予 `Contents: Read and write`。
- PAT 默认仅在当前浏览器会话内保存（`chrome.storage.session`）；仅当用户显式勾选“记住 PAT”时才写入 `chrome.storage.local`，绝不进入浏览器 sync，也不会写入日志或 commit。
- 可使用独立的同步密码通过 Argon2id 与 AES-256-GCM 加密远程操作；同步密码不会保存，遗忘后无法解密远程数据。
- 仅已加密的操作内容会上传。仓库访问者仍可看到 Git 元数据（文件、设备目录、commit 时间与大小）和永久 commit 历史；删除操作是**永久且不可逆**的 tombstone。
- 远程历史被改写（已确认操作缺失、移动路径或内容变化）时，扩展会 **fail-closed**：停止同步、不覆盖远程数据、不自动重置。旧版路径修复只在每个 blob 的 SHA、加密 envelope、仓库 ID、操作 ID 和认证设备 ID 全部验证通过时可用；真实缺失或内容变化仍拒绝修复。
- 远程仓库数据被删除或所有设备副本同时损坏时无法恢复，请保留离线导出备份。

不要提交真实密码、验证码密钥、真实 PAT 或未加密的账户备份。

## 项目关系与许可

本项目源自 [Authenticator-Extension/Authenticator](https://github.com/Authenticator-Extension/Authenticator)。原始项目版权声明为：

```text
Copyright (c) 2017 Authenticator Extension
```

本分支的修改部分声明为：

```text
Modifications Copyright (c) 2026 Van426326
```

项目依据 [MIT License](LICENSE) 使用、修改和分发。根据许可要求，分发本项目或其重要部分时必须保留原始版权声明和完整许可文本。

第三方字体、图标和依赖仍分别受其自身许可证约束。

## 问题反馈

请在本仓库的 [Issues](https://github.com/Van426326/Authenticator/issues) 中提交缺陷或功能建议。安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告。
