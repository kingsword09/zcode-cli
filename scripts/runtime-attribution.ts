export const runtimeModificationNotice = `/*
 * Modified by zcode-app-cli: local runtime compatibility patches and TUI integration.
 * Upstream project: https://github.com/zai-org/ZCode
 * Artifact provenance and applied patches: extraction.json alongside this file.
 * Licenses and notices: ../LICENSES/ and ../docs/THIRD_PARTY_CONTENT.md.
 */
`;

/** Preserve the upstream text and executable shebang when marking a modified bundle. */
export function markRuntimeModified(source: string): string {
  if (source.includes(runtimeModificationNotice)) return source;
  if (!source.startsWith("#!")) return runtimeModificationNotice + source;
  const newline = source.indexOf("\n");
  return newline < 0 ? `${source}\n${runtimeModificationNotice}`
    : source.slice(0, newline + 1) + runtimeModificationNotice + source.slice(newline + 1);
}
