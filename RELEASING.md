# Marketplace 与 GitHub 发布

扩展标识保持 `easecation.mcpywrap-vscode`。已有 [EaseCation Publisher](https://marketplace.visualstudio.com/publishers/easecation)，应使用该发布者现有管理员的 Microsoft 账号；无需创建第二个 Publisher 或变更扩展 ID。GitHub 组织成员资格不会自动赋予 Marketplace 发布权限。

## 推荐：Microsoft Entra 联合身份（无长期密钥）

微软官方发布文档推荐 Microsoft Entra ID 与工作负载身份联合。GitHub Actions 使用 `azure/login` 交换本次运行的 OIDC 身份，`vsce publish --azure-credential` 获取 Marketplace 短期访问令牌。每次运行自动获取令牌，不保存 PAT、客户端密钥或证书；无需每隔数月人工续期密码。身份、授权和联合信任本身不会随本次令牌过期，但仍可能被管理员撤销或受组织策略限制。

一次性配置：

1. 使用已有 **Microsoft Entra 组织租户**创建专用应用注册与企业应用（Service Principal），例如 `mcpywrap-vscode-marketplace`。个人 Microsoft 账号/Marketplace Publisher/Azure DevOps 组织不是 Entra 租户；需要有该租户允许应用注册的权限。此方案只用于 Marketplace，可用 `allow-no-subscriptions: true`，不要求为发布创建付费 Azure 资源，也不授予 Azure 订阅 Contributor。另可使用用户分配的托管身份，但通常需要 Azure 订阅。
2. 应用注册 → Certificates & secrets → Federated credentials，增加 GitHub Actions 联合信任：

   | 字段 | 值 |
   | --- | --- |
   | Issuer | `https://token.actions.githubusercontent.com` |
   | GitHub owner / repository | `EaseCation` / `mcpywrap-vscode` |
   | Entity type / environment | `Environment` / `marketplace` |
   | Subject | `repo:EaseCation@20168691/mcpywrap-vscode@1427359111:environment:marketplace` |
   | Audience | `api://AzureADTokenExchange` |

   本仓库通过 GitHub 公开设置查询确认 `use_immutable_subject=true`，实际 subject 前缀包含组织 ID `20168691` 和仓库 ID `1427359111`，不能照抄旧的纯名称格式。配置前使用 `gh api repos/EaseCation/mcpywrap-vscode/actions/oidc/customization/sub` 检查 `sub_claim_prefix`，并以 GitHub 实际签发值为准；不更改仓库现有 OIDC 格式。

   不创建 Client secret。该信任限定仓库的 marketplace 环境；GitHub Environment 仅允许 `main` 与 `v*` 标签。只有发行工作流的 publish job 有 `id-token: write`；需要进一步限制到特定工作流时可加组织 OIDC claims 策略，不能误认为 environment subject 自带工作流限制。
3. 把应用的 **Application (client) ID** 和 **Directory (tenant) ID** 分别存到 GitHub 仓库 marketplace Environment 的 `AZURE_CLIENT_ID`、`AZURE_TENANT_ID` Secrets。它们是身份标识，不是会过期的密码；不会创建 `AZURE_CLIENT_SECRET` 或 `VSCE_PAT`。设置仓库变量 `MARKETPLACE_AUTH=entra`（默认也是 entra）。
4. 运行凭据检查模式。Azure 登录成功后，工作流通过官方 `az rest ... profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798` 获取 Marketplace profile ID 并写入 job summary。Publisher Owner 在 Members 中将该 ID 以 **Contributor** 角色加入 EaseCation。此 ID 以 Marketplace 实际返回为准，不能用 Entra 应用 ID 或对象 ID 直接替代。首次尚无成员授权时检查失败是预期结果，授权后重新检查。
5. `vsce verify-pat easecation --azure-credential` 验证该身份可以读取 Publisher 角色；该 CLI 检查 Reader 角色也可能通过，因此仍须在 Members 中核对确实为 Contributor，并通过后续真实版本发布验证上传权限。不要把只读身份检查说成已验证市场写入。
6. 完成一次真实发行后开启仓库变量 `MARKETPLACE_PUBLISH_ENABLED=true`，新标签就会自动执行检查并发布同一份 VSIX。手动上架的同版本不再通过 CI 重发。

创建应用/联合信任、授予 Contributor 是一次性安全授权，由账号持有人明确授权；不会改变现有 Publisher Owner。

当前一次性配置已创建专用单租户应用及上述联合凭据，客户端密码/证书均为 0；身份标识保存于 GitHub marketplace Environment。实际 CI 身份与 Publisher 授权验证结果以运行记录为准。已上架版本为 0.1.4，可通过市场安装。

## 可选：Marketplace 原生 GitHub OIDC

`vsce publish --oidc` 直接向 Marketplace 交换 GitHub 身份，省去 Entra 中间层。该入口需要 Marketplace 侧可信发布策略；已核实的 Owner 页面截至 2026-10-21 尚未显示配置入口，不能宣称当前账号已接通。设置 `MARKETPLACE_AUTH=oidc` 显式选择此方式，失败不回退其他凭据。

此路径的 audience 为 `marketplace.visualstudio.com`，不同于 Entra 路径的 `api://AzureADTokenExchange`。绑定 GitHub owner `EaseCation`、repository `mcpywrap-vscode`、workflow `marketplace.yml` 和 environment `marketplace`；实际可配置字段以 Marketplace 支持为准。

### 显式 PAT 过渡方案

现有 Publisher 管理员在 [Azure DevOps](https://dev.azure.com/) 创建仅含 **Marketplace → Manage** 权限的短期 PAT（微软现行文档要求 Organizations 选择 All accessible organizations），仅用于此 Publisher 的发布账号。将它直接保存到 GitHub 仓库 **marketplace Environment** 的 `VSCE_PAT` Secret，不写入仓库、工作流正文或聊天。使用受控发布账号、合理短的有效期，并记录轮换日期。

设置仓库变量 `MARKETPLACE_AUTH=pat` 才会使用此 Secret；默认 `entra` 不读取 PAT，任何身份失败都不回退到 PAT。过渡方案仍需管理员实际创建凭据和校验一次发布。切换回 OIDC 时设置 `MARKETPLACE_AUTH=oidc`，并移除不再需要的 Secret。

创建 PAT 或给 CI 新增 Publisher 权限属于账号持有人的安全授权操作，必须由持有人确认并完成。首次上架也可由 Owner 在 Marketplace 管理页直接上传已经检查的 VSIX，先完成公开可安装验收。

### 发布工具版本

截至 2026-10-21，npm 稳定版 `@vscode/vsce@4.0.0` 的原生 OIDC 实现仍使用旧的 Marketplace 交换协议。官方 `4.0.1-4` 候选版已包含最终协议修复（版本化端点和 `FederatedToken` 授权），本仓库精确固定此版本及锁文件，用于构建和发布。它是发布工具候选版，真实 OIDC 授权/上架仍须在 Publisher 配置后验证；不将仅打包成功当作发布成功。后续升级稳定版时重新运行同样的打包与身份契约检查。

微软发布文档已公告 **2026-12-01 停用 Azure DevOps 全局 PAT**。PAT 是临时过渡选项，需要在届时之前迁移到已验证的 OIDC/Entra 身份方案，不把它当作长期自动发布基础。

## 每次发布

1. 修改 `package.json` 与 `package-lock.json` 的版本，维护 `CHANGELOG.md`，通过 PR 合并 main。
2. 推送与版本一致的 `vX.Y.Z` 标签。标签必须指向 main 历史上的提交，扩展名称和 Publisher 必须匹配。
3. `marketplace.yml` 调用现有三平台打包及 VS Code 1.95.3/stable 宿主检查；全部通过后选用 Ubuntu 构建的同一份 VSIX。
4. 检查 VSIX 内的扩展身份、版本及摘要，然后在 `marketplace` Environment 中使用显式选定的 Entra、直接 OIDC 或 PAT 认证发布这份已检查的包。不会在发布时重新打包、自动加版本、跳过重复版本或回退其他认证。
5. 查看工作流和 [Marketplace 条目](https://marketplace.visualstudio.com/items?itemName=easecation.mcpywrap-vscode)。Marketplace 会执行自己的校验与安全扫描，CLI 上传成功不等于已公开可安装；出现问题先查原版本状态，不自动覆盖或重复发布。

已手动上传某版本后，可用 `verify_credentials=true` 对已配置的 Entra/PAT 做只读身份与 Publisher 成员资格核验，绝不上传或重复发布该版本。此模式优先于 publish=true；直接 Marketplace OIDC 在未配置真实信任时不会伪装成验证成功。

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
- [Azure Login：OIDC 推荐方案](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended)
- [vsce Trusted publishing](https://github.com/microsoft/vscode-vsce#trusted-publishing)
- [最终 OIDC 交换协议修复](https://github.com/microsoft/vscode-vsce/commit/c960f2e97da3360899f2bfe93390fa4890c69327)

- [微软：不可变 GitHub OIDC subject](https://aka.ms/githubImmutableSubjects)
