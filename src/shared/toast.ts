interface ToastElement extends HTMLDivElement {
  __timer?: ReturnType<typeof setTimeout>;
}

export function showToast(msg: string): void {
  let t = document.getElementById("__toast") as ToastElement | null;
  if (!t) {
    t = document.createElement("div") as ToastElement;
    t.id = "__toast";
    t.style.cssText =
      "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--surface-alt,#2a2a3a);color:var(--text,#fff);padding:8px 14px;border-radius:6px;font-size:0.8rem;z-index:2000;opacity:0;transition:opacity 160ms;pointer-events:none;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  if (t.__timer) clearTimeout(t.__timer);
  t.__timer = setTimeout(() => {
    if (t) t.style.opacity = "0";
  }, 2200);
}
