import { describe, it, expect } from "vitest";

// urlBase64ToUint8Array converts a VAPID public key (base64url, unpadded) into
// the raw bytes the Push API wants as applicationServerKey. A wrong decode means
// the browser silently refuses to subscribe, so pin the exact byte mapping.

const { urlBase64ToUint8Array } = await import("../src/shared/push.ts");

// Reference encoder: bytes -> base64url unpadded, mirroring what the daemon sends.
function toB64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("urlBase64ToUint8Array", () => {
  it("decodes a known ascii value", () => {
    // "SGk" is base64 for "Hi" = [72, 105].
    expect(Array.from(urlBase64ToUint8Array("SGk"))).toEqual([72, 105]);
  });

  it("round-trips arbitrary byte arrays including url-safe chars", () => {
    const cases = [
      [0, 1, 2, 3, 4],
      [255, 255, 255], // forces '/'/'+' -> '_'/'-' in base64url
      [251, 240, 190, 63],
      Array.from({ length: 65 }, (_, i) => (i * 7) % 256), // 65-byte P-256 point size
    ];
    for (const bytes of cases) {
      const decoded = Array.from(urlBase64ToUint8Array(toB64Url(bytes)));
      expect(decoded).toEqual(bytes);
    }
  });

  it("handles the unpadded url-safe alphabet (- and _)", () => {
    // [255, 255] -> base64 "//8=" -> base64url unpadded "__8".
    expect(toB64Url([255, 255])).toBe("__8");
    expect(Array.from(urlBase64ToUint8Array("__8"))).toEqual([255, 255]);
  });

  it("produces a Uint8Array", () => {
    expect(urlBase64ToUint8Array("SGk")).toBeInstanceOf(Uint8Array);
  });
});
