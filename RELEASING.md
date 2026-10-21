# Marketplace 与 GitHub 发布

扩展标识保持 `easecation.mcpywrap-vscode`。已有 [EaseCation Publisher](https://marketplace.visualstudio.com/publishers/easecation)，应使用该发布者现有管理员的 Microsoft 账号；无需创建第二个 Publisher 或变更扩展 ID。GitHub 组织成员资格不会自动赋予 Marketplace 发布权限。

## 首次账号配置

1. 登录 [Publisher 管理页](https://marketplace.visualstudio.com/manage/publishers/easecation)，确认可以管理此 Publisher。
2. 在 Marketplace 的可信发布配置中，授权以下 GitHub Actions 身份（界面字段以实际账户提供的功能为准）：

   | 项目 | 值 |
   | --- | --- |
   | GitHub owner | `EaseCation` |
   | Repository | `mcpywrap-vscode` |
   | Workflow | `marketplace.yml` |
   | GitHub environment | `marketplace` |
   | Publisher | `easecation` |

   GitHub OIDC issuer 为 `https://token.actions.githubusercontent.com`，audience 为 `marketplace.visualstudio.com`，environment subject 为 `repo:EaseCation/mcpywrap-vscode:environment:marketplace`。不授权其他仓库或任意工作流。首次上架是否需要先在管理页创建/上传扩展，以账户实际返回为准；未完成真实验证不能将此流程宣称为已上架。
3. 在 GitHub 仓库配置名为 `marketplace` 的 Environment，将部署来源限制为 `v*` 标签和 `main`（后者用于手动指定已存在标签的发布/验证）。配置完成后设置仓库变量 `MARKETPLACE_PUBLISH_ENABLED=true`，才会在推送发行标签时自动上架。该变量是发布开关，不是凭据；测试与打包不需要它。

已在现有 Owner 的管理页面核实 Publisher 权限；截至 2026-10-21，该页面尚未显示可信发布配置入口。以下 OIDC 路径已准备并通过离线契约测试，仍需要管理端开放/配置并通过真实发布验证，不能宣称已接通。

OIDC 使用短期凭据，不需要创建 Azure DevOps PAT 或保存 `VSCE_PAT`。若管理端尚未开放可信发布，可选择微软官方 Microsoft Entra ID 工作负载身份联合方案，或下述显式 PAT 过渡方案；不能假定 GitHub `GITHUB_TOKEN` 可直接发布到 Marketplace。

### 显式 PAT 过渡方案

现有 Publisher 管理员在 [Azure DevOps](https://dev.azure.com/) 创建仅含 **Marketplace → Manage** 权限的短期 PAT（微软现行文档要求 Organizations 选择 All accessible organizations），仅用于此 Publisher 的发布账号。将它直接保存到 GitHub 仓库 **marketplace Environment** 的 `VSCE_PAT` Secret，不写入仓库、工作流正文或聊天。使用受控发布账号、合理短的有效期，并记录轮换日期。

设置仓库变量 `MARKETPLACE_AUTH=pat` 才会使用此 Secret；默认 `oidc` 不读取 PAT，OIDC 失败也不回退到 PAT。过渡方案仍需管理员实际创建凭据和校验一次发布。切换回 OIDC 时设置 `MARKETPLACE_AUTH=oidc`，并移除不再需要的 Secret。

创建 PAT 或给 CI 新增 Publisher 权限属于账号持有人的安全授权操作，必须由持有人确认并完成。首次上架也可由 Owner 在 Marketplace 管理页直接上传已经检查的 VSIX，先完成公开可安装验收。

### 发布工具版本

截至 2026-10-21，npm 稳定版 `@vscode/vsce@4.0.0` 的原生 OIDC 实现仍使用旧的 Marketplace 交换协议。官方 `4.0.1-4` 候选版已包含最终协议修复（版本化端点和 `FederatedToken` 授权），本仓库精确固定此版本及锁文件，用于构建和发布。它是发布工具候选版，真实 OIDC 授权/上架仍须在 Publisher 配置后验证；不将仅打包成功当作发布成功。后续升级稳定版时重新运行同样的打包与身份契约检查。

微软发布文档已公告 **2026-12-01 停用 Azure DevOps 全局 PAT**。PAT 是临时过渡选项，需要在届时之前迁移到已验证的 OIDC/Entra 身份方案，不把它当作长期自动发布基础。

## 每次发布

1. 修改 `package.json` 与 `package-lock.json` 的版本，维护 `CHANGELOG.md`，通过 PR 合并 main。
2. 推送与版本一致的 `vX.Y.Z` 标签。标签必须指向 main 历史上的提交，扩展名称和 Publisher 必须匹配。
3. `marketplace.yml` 调用现有三平台打包及 VS Code 1.95.3/stable 宿主检查；全部通过后选用 Ubuntu 构建的同一份 VSIX。
4. 检查 VSIX 内的扩展身份、版本及摘要，然后在 `marketplace` Environment 中使用显式选定的 OIDC 或 PAT 认证发布这份已检查的包。不会在发布时重新打包、自动加版本、跳过重复版本或回退其他认证。
5. 查看工作流和 [Marketplace 条目](https://marketplace.visualstudio.com/items?itemName=easecation.mcpywrap-vscode)。Marketplace 会执行自己的校验与安全扫描，CLI 上传成功不等于已公开可安装；出现问题先查原版本状态，不自动覆盖或重复发布。

已手动上传某版本后，可用 `verify_credentials=true` 对已配置的 PAT 做只读发布权限核验，完成全部构建和包校验后执行 `vsce verify-pat easecation`，绝不上传或重复发布该版本。此模式优先于 publish=true，当前仅支持显式 PAT 认证；OIDC 在未配置真实信任时不会伪装成验证成功。

```sh
gh workflow run marketplace.yml --ref main -f tag=v0.1.4 -f publish=false -f verify_credentials=true
```

工作流也支持手动选择现有标签。`publish=false` 为默认值，仅运行校验/打包；明确设置 `publish=true` 才会提交到市场。普通分支与 PR 始终只执行无凭据检查。首次配置完成前，可手动对已有 `v0.1.3` 做 dry run 验证流程，无需发布身份。

```sh
# 手动校验；从 main 运行工作流，目标是已发布源码标签
 gh workflow run marketplace.yml --ref main -f tag=v0.1.3 -f publish=false
# 发布已校验的指定标签（配置 Publisher 可信发布后）
 gh workflow run marketplace.yml --ref main -f tag=v0.1.4 -f publish=true
```

GitHub Release 可继续分发通用 VSIX，与 Marketplace 是两个独立渠道。保留 `easecation.mcpywrap-vscode` 的身份可以使手动安装用户在上架后正常获得市场更新。

## 官方参考

- [发布扩展与 Publisher](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [GitHub Actions 自动发布](https://code.visualstudio.com/api/working-with-extensions/continuous-integration#github-actions-automated-publishing)
- [vsce Trusted publishing](https://github.com/microsoft/vscode-vsce#trusted-publishing)
- [最终 OIDC 交换协议修复](https://github.com/microsoft/vscode-vsce/commit/c960f2e97da3360899f2bfe93390fa4890c69327)
