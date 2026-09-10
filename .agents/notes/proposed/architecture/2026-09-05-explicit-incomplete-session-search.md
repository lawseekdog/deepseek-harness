# Agent Note: Explicit incomplete Session search

Status: proposed

English | [中文](2026-09-05-explicit-incomplete-session-search.zh.md)

## Problem

A preserved Session containing an unknown required event makes whole-corpus SQLite reconciliation fail. The log is intact, but the runtime cannot interpret it. Deleting its log or accepting its event name would discard evidence or bypass the execution refusal.

## Proposal

Return required `coverage` and `unsupported_sessions` on search pages. Only `SessionFormatUnsupportedError` raised while inspecting an enumerated Session yields incomplete coverage. Other failures reject. Preserve the Session and original bytes; remove only obsolete derived index rows. Reject exact search or resume of an unsupported target. Revalidate durable logs before reusing a previous process's index, and bind cross-session cursors to coverage changes.

The API and client propagate coverage. Consumers authorize unsupported IDs independently and retain incomplete coverage even when no ID can be disclosed. No raw paths, exception messages, or undisclosed counts cross the authorization boundary.

## Alternatives considered

**Restore retired event names.** Name acceptance does not restore their semantics and could make an incomplete Session continuable.

**Delete or hide the historical Session.** This removes failure evidence and does not address future vocabulary changes.

**Return healthy matches without coverage.** Callers could mistake an incomplete corpus for complete search results.

## Acceptance criteria

Real JSONL logs retain identical bytes, remain listable, and refuse preparation. Healthy results and empty results both report incomplete coverage when appropriate. Arbitrary persistence errors reject. Restart revalidation prevents stale indexed hits from unsupported logs. API and client preserve coverage while restricting IDs. Generated Typert codecs and built package smoke tests must verify the required fields before integration.

## Risks

First-search work increases after restart. Unsupported logs are rechecked until the reader can interpret them; no durable alternative status store is created. A backend that cannot enumerate metadata still fails the entire search. This patch does not supply an event registration or migration mechanism, or broaden authorization for an unreadable historical principal.
