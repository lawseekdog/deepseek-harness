# pi-ai 0.85.1 raw Tool argument patch

This directory contains the npm package patch for `@earendil-works/pi-ai@0.85.1`, the complete
upstream source diff, the exact npm tarball, provenance, and the byte-for-byte baseline
compilation comparison. It does not contain credentials or live model payloads.

The upstream source commit is `d981de1229ef899957bbe968bc8dcda02a21f477` (tag `v0.85.1`) from
`https://github.com/earendil-works/pi.git`. The npm tarball SHA-256 is
`af7d11986179445ce6fe88b37d57de22f823c0ffd3a65cae31c555b7f5e99253`.

## What the patch does

Same semantics as the 0.84.4 patch, unchanged:

- Provider function-call JSON text is kept byte-exact in `ToolCall.rawArguments` and is
  authoritative for replay whenever it is present.
- `parseToolCallArguments` is strict: it returns `undefined` when the provider text is
  incomplete, malformed, or not a JSON object. It never degrades to `{}`.
- `requireToolCallArguments` throws instead of substituting an empty object.
- `serializeToolCallArguments` replays the raw text verbatim when `rawArguments` is present.

No fallback, no lenient recovery path was added for 0.85.1.

## 0.85.1 adaptation

Only four of the original patch's source files were touched upstream between 0.84.4 and 0.85.1.
Three of them (`api/openai-completions.ts`, `api/openai-responses-shared.ts`, `index.ts`) and
`types.ts` received context-only movement; every hunk applied with `git apply --3way` and no
manual merge. Three files needed real work:

1. `packages/ai/src/utils/assistant-message-frame.ts` — **new upstream file in 0.85.1**, the
   streaming frame codec that persists and replays assistant messages. It is now the primary
   consumer of `ToolCall.arguments` and it dropped `rawArguments` on the floor. Adapted:
   - the `toolcall_start` / `toolcall_end` frame variants carry `rawArguments`, and
     `cloneToolCall` preserves it;
   - `serializedArguments` returns `undefined` for `undefined` arguments. Upstream's version
     did `JSON.stringify(argumentsValue)` and then threw `Tool-call arguments are not
     JSON-serializable` when the result was `undefined`, which is exactly what happens for a
     Responses `function_call` whose `output_item.added` carries `arguments: ""`. With strict
     parsing that is the normal state for every tool call at `toolcall_start`, so the encoder
     would have thrown on the first frame of every streamed tool call;
   - an empty strict snapshot (`""`) counts as "caught up": no parsed value is visible yet, so
     every delta must replay verbatim and the raw text stays authoritative;
   - `applyToolCallJson` re-parses the accumulated raw text strictly on `toolcall_checkpoint`
     and `toolcall_delta`, and `reduceAssistantMessageFrames` skips its lenient
     `parseStreamingJson` pass once a call has raw text;
   - `toolcall_end` clears `rawArguments` when the terminal frame carries none.

2. `packages/server/src/protocol.ts` — **removed upstream**; the file and the whole transcript
   conversion layer it belonged to are gone in 0.85.x. Its symbols (`toProtocolJsonValue`,
   `toProtocolAssistantContent`, `toProtocolToolResultMessage`,
   `_AiToolCallFieldsAccountedFor`, `ExactKeys`) have zero occurrences anywhere in the 0.85.1
   tree, so the hunk was dropped rather than ported. There is no new equivalent location: the
   object-only transcript converter it existed to constrain no longer ships.

3. `packages/ai/test/assistant-message-frame.test.ts` — new upstream test in 0.85.1. It reads
   `toolCall.arguments.nested` as if the field were non-nullable. The patch intentionally widens
   `ToolCall.arguments` to `Record<string, any> | undefined`, so the test needed explicit
   `undefined` guards, matching the style already used in that file and in `stream.test.ts`.

The source patch therefore covers 15 files; `packages/server/src/protocol.ts` is the only 0.84.4
patch site with no 0.85.1 counterpart.

## Reproduction

```sh
git clone --filter=blob:none https://github.com/earendil-works/pi.git pi-0851-src
cd pi-0851-src
git fetch --unshallow                 # 3-way apply needs the pre-image blobs
git checkout v0.85.1                  # d981de1229ef899957bbe968bc8dcda02a21f477

git apply --3way /path/to/source-0851.patch   # 15 files

npm ci --ignore-scripts

# The provider catalog is gitignored; restore it from the same-version official package.
mkdir -p packages/ai/src/providers
cp -R /path/to/npm-official/package/dist/providers/data packages/ai/src/providers/data

npm run build --workspace=@earendil-works/pi-telemetry
./node_modules/.bin/tsgo -p packages/ai/tsconfig.build.json

# The compiler reformats JSON on emit; upstream `build:offline` overwrites it with the source
# copy, which is what keeps the catalog byte-identical to the npm package.
rm -rf packages/ai/dist/providers/data
cp -R packages/ai/src/providers/data/. packages/ai/dist/providers/data/

# Regenerate the artifact patch. `git diff --no-index` needs `dist/` to be the first path
# segment of each side, which is why the temporary roots contain a single `dist` directory.
mkdir -p /tmp/pg/a /tmp/pg/b
cp -R /path/to/npm-official/package/dist /tmp/pg/a/
cp -R packages/ai/dist /tmp/pg/b/
cd /tmp/pg && git diff --no-index --no-color a b > raw.diff || true
sed -e 's|^diff --git a/[ab]/|diff --git a/|' \
    -e 's| b/[ab]/| b/|' \
    -e 's|^--- a/[ab]/|--- a/|' \
    -e 's|^+++ b/[ab]/|+++ b/|' \
    -e '/^index [0-9a-f]\{7,\}\.\.[0-9a-f]\{7,\}/d' raw.diff > pi-ai-0.85.1.patch
```

`source-0851.patch` was produced inside the clone with the two added files marked
`git add -N`, so that `git diff` emits them as full new-file hunks; nothing was committed.

To confirm the source patch alone produces the shipped artifact patch, reverse it
(`git apply -R source-0851.patch`), re-apply it from the pristine tag, rebuild, and re-run the
last four commands: the regenerated patch is byte-identical to `pi-ai-0.85.1.patch`
(SHA-256 `d13bd6136e27b7645309b717bd42dbf1d96b1a28c164052616e245b9a0c5ced9`).

## Verification

- **Baseline**: the 708 compiled `.js` / `.d.ts` / `.js.map` / `.d.ts.map` files emitted from the
  unmodified 0.85.1 source are byte-identical to the official npm package's `dist` (zero
  differences), so every difference in `pi-ai-0.85.1.patch` is attributable to this patch.
- **Patched build**: `tsgo` exits 0 with no diagnostics; monorepo `tsgo --noEmit` exits 0.
- **`git apply --check`** succeeds against a fresh extraction of the official npm tarball, and
  the applied tree is identical to the patched build.
- **pnpm 11.7.0**: with `patchedDependencies` the installed `dist` is byte-identical to the
  patched build. Note: pnpm 11.7.0 no longer reads the `pnpm` field of `package.json`
  ("The 'pnpm' field in package.json is no longer read by pnpm... ignored:
  pnpm.patchedDependencies"); the mapping must live in `pnpm-workspace.yaml`:
  `patchedDependencies: { '@earendil-works/pi-ai@0.85.1': patches/pi-ai-0.85.1.patch }`.
- **Tests**: `packages/ai` — 117 files passed, 26 skipped, 1036 tests passed, 847 skipped.
  `packages/agent` (the frame codec's main in-repo consumer) — 52 files, 666 tests passed.

### `git apply` caveat

The patch carries bare `dist/...` paths (that is what pnpm expects, `-p1`). Run `git apply` from
a directory that is **not** inside a git repository — for example the extracted npm tarball
(`git apply --check` and `git apply` both succeed there). Inside a repository, git resolves the
paths against the repository root instead of the current directory, and the outcome depends on
where you stand:

| invocation (repository already initialised) | result |
| --- | --- |
| `git apply -p1 pi-ai-0.85.1.patch` outside any repository | applies, 33 files |
| `cd package && git apply pi-ai-0.85.1.patch` | **exit 0, nothing applied, no message** |
| `git apply pi-ai-0.85.1.patch` from the repository root | exit 1, `No such file or directory` for every file |
| `git apply --directory=package pi-ai-0.85.1.patch` from the repository root | applies, 33 files |

The silent no-op in the second row is the dangerous one: the command reports success and leaves
the package unpatched. The 0.84.4 artifact behaves identically, so this is a property of
`git apply`, not of this patch. pnpm is unaffected — it reads the patch itself and does not shell
out to `git apply`.

## Deployment

Use `pi-ai-0.85.1.patch` under pnpm `patchedDependencies` keyed by the exact package and version
`@earendil-works/pi-ai@0.85.1`, with the mapping placed in `pnpm-workspace.yaml`. The patch
contains only 33 changed JavaScript, declaration, and source-map files under `dist/`. No model
catalog, dependency, or package version changes are included.

## Not covered

- The source patch also adapts the repository's own consumers
  (`packages/coding-agent/examples/extensions/subagent/index.ts`, `packages/evals/src/pi-harness.ts`)
  so that the monorepo typechecks. Those packages are not part of the `pi-ai` npm artifact and
  are not in the patch.
- Live provider streaming (real OpenAI Responses / Chat Completions traffic) was not exercised;
  the 26 skipped `pi-ai` test files include the suites that require credentials. The strict
  argument semantics and the frame round-trip are covered by the offline unit tests only.
- Downstream consumers of `@earendil-works/pi-ai` that construct `ToolCall` values see the
  widened `arguments: Record<string, any> | undefined` type and must handle it; that type change
  is deliberate and is not softened by this patch.
