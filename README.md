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
- 可选密码加密、自动锁定、浏览器同步和云备份
- 针对 OTP 刷新、搜索和生产构建的性能优化

## 从源码安装

### 环境要求

- Node.js 20
- npm
- Git

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

生产构建需要自行配置 `src/models/credentials.ts` 中涉及第三方服务的凭据：

```bash
npm run prod
```

不要提交真实 API 密钥、OAuth 密钥、验证码密钥或未加密的账户备份。

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
