# Third-party content in the published package

This project's original launcher, TUI and supporting code use the
[MIT license](../LICENSE). The npm package also contains upstream code and
dependencies; the MIT declaration in `package.json` does not replace their terms.

## Source and release provenance

[zai-org/ZCode](https://github.com/zai-org/ZCode) publishes first-party source
under Apache-2.0. Its root notices explicitly preserve separate terms for
third-party code, dependencies, assets and native binaries.

This project extracts the compiled runtime from Desktop release artifacts,
rather than building that source tree. Release artifacts are pinned by URL and
SHA-512 in `zcode-runtime.lock.json`. Local development can instead use an
installed Desktop app. `vendor/extraction.json` records the source, version and
compatibility patches applied.

The [upstream notices shipped here](../LICENSES/README.md) come from a separately
pinned public source revision. That revision declares version 3.14.0; the current
runtime lock selects Desktop 3.14.1. The notices are a conservative upstream
inventory, not proof that the extracted binary was built from that exact commit
or that every listed component is included in this npm package. Review artifact
contents and applicable terms when updating the runtime.

## Included components

| Component | Package location | Attribution and terms |
| --- | --- | --- |
| Extracted agent runtime | `vendor/zcode.cjs` | ZCode first-party source: Apache-2.0; embedded dependencies retain their own terms |
| Provider catalog | `vendor/provider/zcode-builtin.json` | Copied from the selected Desktop artifact; upstream first-party source: Apache-2.0 |
| Built-in plugin packages | `vendor/packages/*` | Per-package declarations and any nested license files; see below |
| Bundled npm dependencies | Inside runtime bundles and plugin `node_modules` | Original dependency licenses and notices |
| Local TUI adapter and configuration bridge | `vendor/node_modules/@zcode/tui`, `vendor/cli-config.cjs` | This project's MIT-licensed code and its dependencies |
| Public launcher | `bin/zcode.js` | This project's MIT-licensed code |
| Installed npm dependencies | `@earendil-works/pi-tui`, `playwright-core` and their dependencies | Their respective licenses, distributed with those packages |

The compiled runtime carries a notice identifying local modifications.
Synchronization retains the existing upstream content and adds compatibility
patches; the patch report is in `vendor/extraction.json`.

## Plugin declarations

These are the declarations observed in the Desktop 3.14.1 packages, not a
replacement for nested dependency or asset licenses:

| Package directory | Manifest declaration |
| --- | --- |
| `browser-use-plugin` | MIT |
| `image-search-plugin` | Apache-2.0 |
| `node-repl-host` | No package-level license field; its public first-party source falls under the upstream root Apache-2.0 license |
| `skill-creator-plugin`, `plugin-creator-plugin`, `zcode-guide-plugin` | MIT |
| `zcode-cua-plugin`, `ios-simulator-plugin`, `android-emulator-plugin` | MIT |
| `restore-legacy-sessions-plugin` | MIT |

A package's manifest does not establish the license of every bundled asset.
For example, the public source repository describes Computer Use as a placeholder;
it must not be assumed identical to the implementation in a Desktop artifact.
Preserve the license and notice files distributed with dependencies.

## Document plugins

The following Desktop packages declare `SEE LICENSE IN skills/<name>/LICENSE.txt`.
Their skill licenses state:

> Copyright (c) 2026 Z.ai All rights reserved.
>
> Permission is granted for personal, educational, and non-commercial use only.
>
> Commercial use is strictly prohibited without prior written permission from the author.

| Package directory | License file within the package |
| --- | --- |
| `documents-plugin` | `skills/docx/LICENSE.txt` |
| `pdf-plugin` | `skills/pdf/LICENSE.txt` |
| `presentations-plugin` | `skills/pptx/LICENSE.txt` |
| `spreadsheets-plugin` | `skills/xlsx/LICENSE.txt` |

This project includes these four packages in its non-commercial npm distribution
with their original skill license files. Their use restrictions remain in effect;
this project's MIT license does not replace those terms.

Synchronization copies these plugins from the selected Desktop source into
`vendor/packages/`, and `package.json` includes them in the npm package. The
installed-package smoke test verifies that all four plugins initialize and are
enabled. Package validation and installation checks also require their original
skill license files.

## Notices shipped with the package

- [Apache-2.0 license](../LICENSES/Apache-2.0.txt)
- [Upstream NOTICE](../LICENSES/ZCode-NOTICE.md)
- [Upstream third-party notices](../LICENSES/ZCode-THIRD-PARTY-NOTICES.md)
- [Notice provenance and scope](../LICENSES/README.md)

These copies retain the upstream text with LF line endings. Relative links inside
them refer to the upstream source tree, not this repository. Upstream behavioral descriptions
apply to the distributions they describe; this CLI's behavior is documented in
its own README and configuration guide.

ZCode and Z.ai names identify the upstream project. This community client is
not affiliated with or endorsed by Z.ai.
