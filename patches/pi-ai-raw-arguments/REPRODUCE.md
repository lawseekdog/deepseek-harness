# pi-ai 0.84.4 raw Tool argument patch

This directory contains the npm package patch, complete upstream source diff, provenance referencing the exact npm tarball, and the byte-for-byte baseline compilation comparison. It does not contain credentials or live model payloads.

The upstream source commit is `b79e4cc834970cca69daebffab7df1da7d1e52c4` from `https://github.com/earendil-works/pi.git`. The npm tarball SHA-256 is `dfd3c929cee5a7387199a0a24dfc1be2096f1ea8f59ffb8285198a0ed01ebf93`.

To reproduce from source, check out that commit, apply `source.patch`, and run `npm ci --ignore-scripts`. Restore the ignored `packages/ai/src/providers/data/` directory from the same-version official npm package's `dist/providers/data/`. Run `npm run build --workspace=@earendil-works/pi-telemetry`, then `./node_modules/.bin/tsgo -p packages/ai/tsconfig.build.json`. Copy the source provider-data directory over `packages/ai/dist/providers/data/`, matching upstream `build:offline`; the compiler's JSON formatting is not a catalog change. The 704 emitted JavaScript, declaration, and map files from the unmodified source were identical to the npm package before this patch.

For deployment, use `pi-ai-0.84.4.patch` under pnpm `patchedDependencies` keyed by the exact package and version `@earendil-works/pi-ai@0.84.4`. The patch contains only 29 changed JavaScript, declaration, and source-map files. No model catalog, dependency, or package version changes are included. `git apply --check` succeeds against the extracted official npm package; pnpm 11.7.0 applied it successfully in the DSH source checkout.

This DSH fork pins pi-ai 0.84.4 in its workspace override and records this repository-relative patch in its committed lockfile. Run `pnpm install --frozen-lockfile --ignore-scripts` from the repository root, then `pnpm run build:lib:host`. Compilation does not require the temporary source checkout used to create this patch.

Verification: pi-ai's root `npm run check` passes, including all TypeScript consumers and browser smoke. Seven targeted test files pass 53 tests. The pre-existing live `stream.test.ts` received only an explicit undefined guard required by the public type change; its live matrix was not run. The DSH adapter passes 312 tests with 100% package coverage and the full Host build. Its new fixture runs through the real OpenAI SDK SSE parser, Harness BlockAssembler, persisted JSON, and the next SDK request. Main-workspace installed Loader and AgentLoop acceptance is verified separately before deployment.

The source patch includes necessary type adaptations in the upstream example, eval, server transcript conversion, and live test; these packages are not included in the pi-ai npm artifact. Object-only transcript converters explicitly reject arguments that cannot be represented as objects. Responses and Chat Completions keep exact argument text.
