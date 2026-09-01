export interface StreamErrorSource {
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

export function watchStreamErrors(
  sources: readonly StreamErrorSource[],
  onError: (error: Error) => void
): () => void {
  const uniqueSources = [...new Set(sources)];
  for (const source of uniqueSources) source.on("error", onError);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const source of uniqueSources) source.off("error", onError);
  };
}
