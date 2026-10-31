# Dependency fixes

Install source dependencies with the pinned Bun 1.4.1 toolchain and
`bun install --frozen-lockfile`. Bun applies the patches recorded in
`package.json` and `bun.lock`; npm does not apply Bun patches. These fixes
belong to the development/test shell, which is not shipped in the CLI runtime.

## sprintf-js 1.1.3

[`GHSA-hp3w-g68c-fv3c`](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
has no published fixed version as of 2026-10-16. The patch to the Node entry
`src/sprintf.js` clamps `e`/`f` precision to 0–100 and `g` precision to 1–100
before formatting. It preserves zero precision, ordinary formats, named and
positional arguments, and string truncation. Both `sprintf` and `vsprintf`
use this parser. It does not patch the unused browser/minified entry points.

The installed `just-bash` Node bundle imports this entry for fallback formats.
Its ordinary floating-point `printf` implementation uses its own formatter
and already converts precision errors into stderr and exit code 1. Its `awk`
formatter rejects precision above 100 with exit code 126. The minimal regression
directly checks that the patched formatter bounds hostile precision and preserves
normal formatting; it does not repeat the shell implementation's own tests:

```sh
bun test test/shell-security.test.ts
```

`bun audit` still reports this one moderate advisory because the installed
package retains upstream version 1.1.3. The advisory is not ignored or hidden.
Remove the patch only after adopting a fixed upstream version and rerunning
the regressions above.

## Transitive updates

`just-bash` 3.6.0 removes `minimatch`/`brace-expansion` and requires the fixed
`smol-toml` 1.9.x parser (the lock selects 1.9.1).

`guarded-fetch` 0.1.3, pinned by `just-bash`, pins vulnerable `undici` 7.29.0.
The root override selects 7.30.0, which includes the 7.29.1 security fixes.
Remove the override once the shell's dependency chain selects a safe version
on its own, then rerun `bun audit` and the shell scenarios.
