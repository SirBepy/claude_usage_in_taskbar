import { api } from "./api";

const EXTERNAL_SCHEMES = ["http://", "https://", "mailto:", "file://"];

function isExternal(href: string): boolean {
  const lower = href.toLowerCase();
  return EXTERNAL_SCHEMES.some((s) => lower.startsWith(s));
}

function handleClick(e: MouseEvent): void {
  if (e.defaultPrevented) return;
  const target = e.target as Element | null;
  const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute("href") || "";
  if (!isExternal(href)) return;
  e.preventDefault();
  e.stopPropagation();
  void api.openExternal(href).catch((err) => {
    console.warn("[external-links] openExternal failed", err);
  });
}

export function installExternalLinkInterceptor(): void {
  document.addEventListener("click", handleClick, true);
  document.addEventListener("auxclick", handleClick, true);
}
