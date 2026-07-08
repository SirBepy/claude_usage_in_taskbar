// Awaitable confirm for Tauri webviews. Tauri patches `window.confirm` to the
// dialog plugin's `confirm` command, which returns a PROMISE - so the classic
// `if (!confirm(...))` guard never waits and never blocks (past incident:
// account removal ran with no confirmation shown). This helper works with
// both the patched (Promise<boolean>) and native (boolean) forms. Requires
// `dialog:allow-confirm` in the window's capability; a denied/failed dialog
// resolves `false` so destructive actions fail closed.
export async function askConfirm(text: string): Promise<boolean> {
  try {
    return (await Promise.resolve(window.confirm(text) as boolean | Promise<boolean>)) === true;
  } catch (e) {
    console.error("[confirm] dialog failed; treating as cancelled", e);
    return false;
  }
}
