# CLI 契约与兼容策略

兼容基线：mcpy 0.5.2，来源是公开帮助及一次性 JSON 响应。当前 mcpy 没有全局统一的协议协商入口；本项目只依赖以下最小字段，兼容附加字段。此页不将内部实现变成契约。

## 1. 调用规则

使用可执行文件与 argv 数组，shell=false，cwd 为明确项目。全局前缀为 `--local --project <absolute-root> --non-interactive`。有限命令末尾 `--json`；stdout 解析为单个 JSON 对象，stderr 只作为诊断，不混入 JSON。显式 --local 覆盖用户环境中的远端设置；首版仅支持本机。

可执行文件设置不是 shell 命令，不支持附带参数。相对工具名通过 PATH 查找；绝对路径可含空格和 Unicode。扩展不自动安装、更新、降级 mcpy。

## 2. 使用的命令

| 用途 | 命令（省略公共前缀与 --json） | 最小有效响应 |
| --- | --- | --- |
| 会话与组 | status --list | sessions[]，groups[] |
| 世界 | run --list | instances[] |
| 启动 | run [world-id] --no-gui --detach [--new] [--clients 2] | session 或 group，state |
| 停止 | stop --session/--group ID | ok；附加状态原样保留 |
| 能力 | runtime capabilities --session ID | python.sides[]、python.reload_sides[]、reload.python.state |
| 组能力 | runtime capabilities --group ID | coordinated_reload；members 等附加结果保留 |
| 执行 | runtime py --session ID --side client/server --file TEMP | state、stdout/stderr/value/error、可选 request_id |
| 热更 | runtime reload python --session/--group ID --side SIDE --file FILE | state 或组 results，ok，effect_verified 等原样保留 |
| 日志 | logs --session/--group ID --source game/engine/worker --tail 300 | text 或 logs[] 中的 text、role、session |
| 环境 | doctor | ok、state、hint、诊断等，完整显示 |

标识符来自 CLI 响应，作为一个参数传入；不拼接 shell。Session 可带 group，若缺省则从公开 groups[].members 建立关系。world/session/group 保持分开。

状态字面量是可扩展字符串；不认识的状态可显示，但不能据此开放 Python 执行。只有实际返回的 sides/reload_sides 允许出现为端侧选项。

## 3. 响应与错误

合法响应必须为对象，且包含 boolean ok。关键列表必须有正确类型；关键身份缺失时拒绝该响应，避免将错误转成空列表或随机目标。stderr 与输出有长度上限；使用流的 UTF-8 解码，防止跨 chunk 的中文被损坏。

ok=false 保留 error/code/hint 及原始结构化结果。执行与组热更的失败结果仍用于展示，不因异常处理丢掉 request_id 或成员详情。unknown/partial 不能显示为成功。

spawn 失败为未提交。已 spawn 的变更命令发生超时、非 JSON、超量响应或异常退出，视为结果未知；终止等待不撤销副作用。查询的同类错误仅表示查询失败。没有自动重试；用户刷新状态或查看日志后再决策。

## 4. 当前缺口与通用能力提案

已增加通用 follow 日志；当前没有可恢复 cursor、watch JSON 事件、项目 inspect、通用 debug metadata 和部署源码映射。它们均不属于本扩展假设的现有接口。

未来可向 mcpy 提出通用能力：带 schema_version 的项目/会话查询、cursor 日志事件、稳定 action/request 标识、debug endpoint 与侧别、按部署 fingerprint 绑定的源码/行号映射。CLI、Qt、Agent 与其他编辑器应能共同使用这些能力，不能命名为 vscode 专用协议。

## 5. 契约验证

独立 fake CLI 在不安装 mcpy/Python 的情况下验证参数与 JSON。实际 mcpy 的只读验证仅使用版本、帮助和已选测试工程的 status/list，不启动游戏。真机验收另行验证指定版本的游戏执行效果，不从帮助或 mock 推断。

## 6. 本机增量日志协议

`logs --session/--group ID --follow --source all --format jsonl --tail 100` 为长期命令，不带 --json。每行独立对象：schema_version=1，event=log/state/reset/end。log 含 session/source/text，可选 role；state 含 session/state；reset 含 session/source；end 表示所有成员结束且日志排空。text 可以是半行。插件验证身份必须属于已绑定目标，限制单帧和缓冲区，断开仅关闭订阅。

此能力在 mcpy 0.5.2 基线后新增；以命令是否支持为准，旧版本明确报能力缺失并提示更新，不访问内部日志文件兜底。
