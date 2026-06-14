import type { ContentBlock } from "../../types/ipc.generated";

export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b && b.type === "text" ? b.text : ""))
    .filter((s) => s)
    .join("\n");
}
