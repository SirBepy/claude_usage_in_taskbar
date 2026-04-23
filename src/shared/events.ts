// Window.__TAURI__ type lives in shared/ipc.ts.

export async function listen<T>(
  event: string,
  cb: (payload: T) => void,
): Promise<() => void> {
  const ev = window.__TAURI__?.event;
  if (!ev?.listen) {
    return () => {};
  }
  return ev.listen<T>(event, (e) => cb(e.payload));
}
