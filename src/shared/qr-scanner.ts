// Thin wrapper: opens a camera overlay, resolves with the decoded URL string,
// rejects if the user cancels or camera access is denied.

export function scanQrCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Lazy-import qr-scanner so it doesn't load in the Tauri desktop build
    import("qr-scanner").then(({ default: QrScanner }) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = [
        "position:fixed", "inset:0", "background:rgba(0,0,0,.85)",
        "display:flex", "flex-direction:column", "align-items:center",
        "justify-content:center", "z-index:10000", "gap:16px",
      ].join(";");

      const video = document.createElement("video");
      video.style.cssText = "width:min(320px,90vw);border-radius:12px;background:#000";

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText = [
        "padding:8px 24px", "background:transparent", "color:#fff",
        "border:1px solid #fff", "border-radius:8px", "cursor:pointer",
        "font-size:.95rem",
      ].join(";");

      overlay.append(video, cancelBtn);
      document.body.appendChild(overlay);

      const scanner = new QrScanner(video, (result: { data: string }) => {
        scanner.destroy();
        overlay.remove();
        resolve(result.data);
      }, { returnDetailedScanResult: true });

      cancelBtn.onclick = () => {
        scanner.destroy();
        overlay.remove();
        reject(new Error("cancelled"));
      };

      scanner.start().catch((e: unknown) => {
        scanner.destroy();
        overlay.remove();
        reject(e);
      });
    }).catch(reject);
  });
}
