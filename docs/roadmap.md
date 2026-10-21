# 交付路线、验收与范围

## 1. 当前交付

独立项目、用户场景、交互状态、领域/端口架构、CLI 契约、可构建的基础实现及独立测试。当前实现的入口覆盖场景 S1–S6 的基础操作；真实游戏效果仍须在目标环境完成验收。未提供自动热更和断点的可运行入口。

| 要求 | 代码/文档证据 | 验证 |
| --- | --- | --- |
| 独立项目与发布 | package.json、lockfile、CI、VSIX | npm ci/check/package，不检出 mcpy |
| 从用户场景逐层设计 | product → interaction → architecture → cli-contract | 场景、状态、领域与接口相互映射 |
| 单向、低耦合 | application ports、infrastructure CLI、架构规则 | check:architecture、fake CLI contract tests |
| 项目和目标正确 | discovery、应用用例、目标 QuickPick | 多项目/嵌套路径、组成员路由测试 |
| 不误报执行结果 | transport/gateway、结果输出 | failed/unknown/partial、失效能力、异常 JSON 测试 |
| 实际 VS Code 装载 | activation/commands/tree | 隔离 Extension Host smoke tests |

## 2. 后续阶段与依赖

**阶段 1：基础流程实机验收与预览反馈。** 在 Windows 与 Apple Silicon macOS 上用独立测试项目，验证已有/新建世界、双人手动加入、Python 端侧、组热更和停止。检查保存进度、脚本准备失败和编辑器重载恢复。需要 mcpy 已安装和目标运行包；不允许 mock 结果替代。

**阶段 2：日常迭代体验。** 添加公开 watch 命令的 TaskProvider、watch 生命周期、结构化进度、只读环境引导与明确的新建世界参数。通用 follow 日志、原生双通道输出和原生片段编辑器已接入；可恢复 cursor 仍待后续能力支持。验收 watcher 退出保留游戏、两端选择、结构变化需重开、未知结果不重复注入。

**阶段 3：通用调试基础。** 先在 mcpy/独立后端验证 Windows 内置 ptvsd、macOS trace 或原生 hook。补齐通用 endpoint、能力、暂停控制与来源/行号映射。游戏 Python 2 与当前 Python Debugger 的协议兼容性逐版本测试；后端不放在 VS Code 扩展中。

**阶段 4：VS Code 调试客户端。** 当通用能力完成后提供 F5 launch/attach、断点、调用栈、locals、step/continue/detach。验证暂停时仍能接收继续命令、热更断点重绑、编码头行号、多源依赖映射及不同端侧。按实证开放平台/版本，拒绝用“端口能连接”作为完成证据。

**阶段 5：测试入口。** 使用公开代码执行触发项目预留的测试函数，增加 Test Explorer 与结构化结果；UI 树/截图按已有通用能力接入。业务测试代码仍只使用 ModSDK 和项目代码，不依赖临时 mcpy 调试 API。

## 3. 当前不做

不复制 Python 依赖解析、项目脚本引擎、游戏安装器、部署锁、worker、注入器；不嵌入 Qt；不自动更改项目配置；不在未验证能力上承诺断点；不复用本机游戏逻辑到 Remote SSH/WSL。后续范围变动需更新用户场景与边界决策。

## 4. 真实游戏验收矩阵

每次记录：扩展版本、mcpy 版本、运行包/引擎版本、Windows/macOS、local/network、client/server、单人/组、预期效果、日志证据、自己创建的 session/group、清理结果。

覆盖 S1 首次环境缺失和新建世界；S2 保存进度、复用已有进程与 source_matches；S3 真实值/异常/未知结果；S4 客机等待加入、整组更新与停止；S5 双项目、双窗口与依赖同名源码；S6 CLI 超时、错误恢复、重载编辑器；S7 断点命中、局部变量、单步、继续、detach 与退出恢复。
