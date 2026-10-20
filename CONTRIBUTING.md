# 参与开发

欢迎通过 Issue 讨论需求，或提交 Pull Request。提交行为变更时说明具体用户场景、预期结果与验证方式；较大功能先对应产品、交互和架构文档。

## 本地检查

需要 Node.js 22+ 和 npm。安装锁定依赖并运行：

```sh
npm ci
npm run check
npm run package
```

单元和契约测试使用独立 CLI fixture，不需要 Python、mcpy 或游戏。在 macOS 上运行 `npm run test:extension`，可验证完整的编辑器到 fake CLI 流程。Windows 宿主测试当前仅覆盖激活/发现，Linux 验证本机游戏功能的未支持状态；各平台子进程契约仍由单元测试覆盖。

VS Code 默认下载 stable 版本。指定 `VSCODE_TEST_VERSION=1.95.3` 可验证最低兼容版本；`VSCODE_EXECUTABLE_PATH` 则直接选择已有 Code 可执行文件。测试使用临时工作区和扩展目录，不在个人配置中安装本扩展。

## 保持独立边界

- domain 不导入基础设施；application 仅依赖领域和自身端口。
- presentation 使用 VS Code API 和应用用例，不拼 CLI 参数或解释原始响应。
- infrastructure 只调用公开 CLI，不读取 mcpy 内部运行文件或导入其源码。
- mcpy 拥有项目准备、依赖、部署、进程与锁；不要在扩展内复制这些机制。
- 对已提交但结果未知的变更，保留目标和请求证据，不自动重试。

`npm run check:architecture` 检查基本导入方向。协议变化请更新 CLI 契约及对应 fixture；不能只修改 fixture 来掩盖实际不兼容。

## 游戏和调试能力验收

新 CLI 或后端能力应独立于编辑器。自动热更、连续日志和断点等功能按 [交付路线](docs/roadmap.md) 实现，当前尚未提供的入口不能假定可用。

真实游戏验证使用独立测试工程，记录平台、mcpy/扩展/运行包版本、端侧、会话和效果证据，并清理自己创建的会话。不要结束用户已有游戏，不要提交账号凭据、存档、过程日志或机器绝对路径。Mock/CI 通过不能代替玩法效果和真实断点验证。

## 提交与发布

Pull Request 的 CI 会完成三平台检查、VSIX 构建和 macOS 宿主测试。通过后可从 Actions artifact 获取 VSIX；目前未配置 Marketplace 自动发布。GitHub 仓库代码使用 MIT 协议，新增打包依赖时同步维护第三方许可。
