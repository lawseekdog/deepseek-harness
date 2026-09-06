# Agent Note: Session-scoped transport observation

Status: proposed

English | [中文](2026-09-06-session-transport-observation.zh.md)

## Problem

A terminal model chunk and an HTTP body reaching EOF are separate observations. Adapter timeout reports without request identifiers or transport timing cannot identify which layer stopped progressing. Persisting message bodies for this diagnosis exposes user content and duplicates Session history.

## Proposal

The pi-ai adapter observes explicitly selected Sessions at its existing SDK fetch and stream iterator. Configuration remains disabled when omitted or null. A private named logger receives bounded metadata only, and a dedicated Cordis exporter writes only those exact records to process stdout; it cannot export other plugin messages. The adapter preserves request arguments, response bytes, cancellation and provider exceptions. The package [README](../../../../packages/llm/llm-pi-ai/README.md#observe-transport-metadata-for-selected-sessions) owns configuration and metadata semantics.

The observation identifier belongs only to one adapter invocation. HTTP ordinals do not claim to be Agent attempt IDs. Missing official turn or trace context stays missing, and diagnostic logs never become evidence of a business commit. The change affects neither Session events nor model-visible input.

## Alternatives considered

**Infer EOF from a semantic finish or DONE marker.** This erases the distinction needed to locate an open-body stall.

**Capture raw requests and complete responses.** This duplicates private message content and is unnecessary for timing and request-ID evidence.

**Patch installed dependencies or change timeouts.** Installed edits lack a maintained source, while changing timeout or completion policy without transport evidence can hide the failure being investigated.

**Read a cloned response independently.** A second reader can consume ahead and retain unbounded queued data. Observation instead follows the SDK's own pulls.

**Mount the general console logger for the plugin namespace.** Its level filter cannot distinguish transport records from unrelated messages in the same namespace. A message-filtered exporter keeps the process-log surface limited to the already-redacted metadata.

## Acceptance criteria

Focused tests prove default-off and exact-Session selection, byte identity, split SSE framing, separate DONE/EOF, cancellation, provider errors, bounded parsing and sink failure containment. A real Loader composition with a local HTTP fixture proves the plugin logger receives metadata, stdout receives only the redacted records, unrelated logger and model content stay absent, and the SDK produces the unchanged model result. Package compilation and documentation checks pass before publication. Real-model evidence is collected only during an authorized normal request, and cannot retrospectively establish an earlier failed request's transport facts.

## Risks

Per-frame parsing adds bounded memory and CPU overhead on selected requests. Logger retention remains deployment-owned; dropped records or a missing terminal observation can limit conclusions. The initial observer supports only openai-completions and does not change other protocols.
