<!-- Thanks for the PR! Keep it small and focused. / 谢谢!请保持小而聚焦。 -->

## What & why / 做了什么 · 为什么

<!-- Describe the change and link any related issue (e.g. Closes #123). -->
<!-- 描述改动,并关联相关 issue(如 Closes #123)。 -->

## Checklist / 自查

- [ ] `corepack pnpm -r run typecheck` passes / 类型检查通过
- [ ] `corepack pnpm smoke` passes / 冒烟测试通过
- [ ] Docs updated if behavior/API changed / 若行为或 API 变了,已更新文档
- [ ] Change is surgical — only touches what's needed / 改动外科手术式,只碰必要的

## Soft-fork / consensus compatibility / 软分叉与共识兼容性

<!-- Fill this in ONLY if you touched validation, applyTx/computeState, or consensus. -->
<!-- 仅当你动了校验、applyTx/computeState 或共识时才填。 -->

- [ ] Not applicable — no consensus/validation change / 不涉及:未改共识或校验
- [ ] This is a memo-convention change; old nodes stay compatible / memo 约定改动,老节点保持兼容
- [ ] This changes consensus and needs an activation height (explain below) / 改了共识,需激活高度(下方说明)

<!-- If consensus changes: activation height, backward-compat plan, upgrade window. -->
<!-- 若改共识:激活高度、向后兼容方案、升级窗口。 -->
