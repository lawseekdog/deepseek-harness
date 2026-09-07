# Agent Note: Preserve native pi-ai Tool argument text

Status: implemented

English | [中文](2026-09-07-pi-ai-raw-tool-arguments.zh.md)

## Problem

The Responses provider can finish a Tool call with malformed JSON. Parsing and re-stringifying that text changes the call before the Harness validator sees it. Replacing malformed historical arguments with an empty object also prevents the next model request from reproducing the recorded failure.

## Decision

The [pi-ai adapter](../../../../packages/llm/llm-pi-ai/README.md) uses the maintained pi-ai dependency patch that carries native argument text in `ToolCall.rawArguments`. Parsed arguments are undefined when strict JSON parsing cannot produce an object. Stream conversion records the original string in existing Harness Tool-call content; replay reconstructs both the original string and its strictly derived object. No additional Session event or persistent state is required.

## Alternatives considered

Reconstructing request history with a payload hook would duplicate provider conversion and require placeholder argument objects. Capturing only deltas would miss final argument replacements. The dependency retains the provider's final argument string and uses its native Responses and Chat Completions serializers.

## Consequences

Malformed arguments reach ordinary Harness Tool validation unchanged and remain in subsequent model history. Object-only protocols reject malformed or non-object argument history explicitly. SDK/SSE tests exercise final text differing from deltas, durable BlockAssembler content, and the next request; installed Loader and AgentLoop acceptance remains a distribution-level check. The package requires the matched pi-ai patch during compilation and installation.
