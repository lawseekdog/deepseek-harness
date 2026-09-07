# Agent Note: 保留 pi-ai 原始 Tool 参数文本

Status: implemented

[English](2026-09-07-pi-ai-raw-tool-arguments.md) | 中文

## Problem

Responses 提供方可能以非法 JSON 结束一次 Tool 调用。先解析再序列化该文本会在 Harness 校验器看到它之前改写调用。把非法历史参数替换为空对象，也会使下一次模型请求无法复现已记录的失败。

## Decision

[pi-ai 适配器](../../../../packages/llm/llm-pi-ai/README.zh.md)使用受维护的 pi-ai 依赖补丁，通过 `ToolCall.rawArguments` 承载原始参数文本。严格 JSON 解析无法得到对象时，解析参数为 undefined。流转换把原始字符串记录在现有 Harness Tool-call 内容中；回放重建原始字符串及其严格派生对象。不需要新增 Session 事件或持久状态。

## Alternatives considered

使用 payload hook 重建请求历史会重复提供方转换逻辑，并需要占位参数对象。只捕获增量会遗漏最终参数替换。依赖保留提供方的最终参数字符串，并使用原生 Responses 和 Chat Completions 序列化器。

## Consequences

非法参数不经改写进入常规 Harness Tool 校验，并保留在后续模型历史中。只接受对象的协议明确拒绝非法或非对象参数历史。SDK/SSE 测试覆盖最终文本与增量不同、持久化 BlockAssembler 内容及下一次请求；实际安装包的 Loader 和 AgentLoop 验收属于分发验证。本包编译与安装需要匹配的 pi-ai 补丁。
