// Keep the headless Node process alive long enough for Undici to surface the
// reset; the interactive TUI already has terminal handles that serve this role.
setTimeout(() => {}, 5_000);
