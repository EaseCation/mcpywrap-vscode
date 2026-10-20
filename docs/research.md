# 竞品证据与设计取舍

调研日期 2026-10-21。仅进行源码审阅；没有运行竞品二进制或确认真机效果。

| 来源 | 快照 | 可复核事实 |
| --- | --- | --- |
| [MCDevTool](https://github.com/GitHub-Zero123/MCDevTool/tree/d7b6e296653cdf06a66290439d66dbcaa5120405) | d7b6e29 | mcdk 负责游戏与热更，支持 Host Bridge 和 debug_ip/debug_port 参数 |
| [mcdev-tools](https://github.com/Dofes/mcdev-tools/tree/a31d4a4514593c78745dded5cad19eab0d87fb4b) | a31d4a4，0.1.32 | TypeScript 扩展、React Webview、默认 ptvsd 启动编排与可选注入 |
| [mcpdb](https://github.com/Dofes/mcpdb/tree/9a39aa16e2467d4ef3261eb9e26fb966165d7ab0) | 9a39aa1 | Windows x64 自实现 DAP 与 Python 2 解释器原生 hook |

竞品值得借鉴的是工作区内的完整测试循环、把启动器与编辑器分开，以及区分控制台和断点。它的 Host Bridge 为自身提供会话状态与 RPC，但 mcpy 已有独立 worker 和公开 CLI，本项目无需复制专用桥接协议。

竞品默认调试配置实际返回 type=python，注入配置返回 type=debugpy；代码注释中的“debugpy”不足以证明当前 Python Debugger 与所有游戏 ptvsd 版本兼容。运行时 Python 执行和真正暂停调试是不同能力。

对 mcpy 的一次性调研还发现：装配合并多个来源，编码头可能增加行号，热更 compile 使用虚拟文件名。断点映射应由通用构建/部署与调试能力解决，编辑器不能从私有路径自行猜测。

本项目独立实现，仅借鉴公开架构思路，未复制竞品代码或二进制。本页保留可复核结论；当次调查的本地过程笔记不属于插件构建输入。
