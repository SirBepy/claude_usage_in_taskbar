import type { ChatEvent } from "../../../types/ipc.generated";
import { sessionEvents } from "../event-store";
import type { BuiltinHandler } from "./index";

export const showCost: BuiltinHandler = async (_parsed, ctx) => {
  if (!ctx.sessionId) return;
  const r = ctx.getRenderer();
  const u = r?.cumulativeUsage ?? {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    turns: 0,
    costUsd: 0,
  };

  const lines = [
    `**Session usage** — ${u.turns} turn${u.turns === 1 ? "" : "s"}`,
    "",
    `- Input: ${u.input.toLocaleString()} tokens`,
    `- Output: ${u.output.toLocaleString()} tokens`,
    `- Cache create: ${u.cacheCreate.toLocaleString()} tokens`,
    `- Cache read: ${u.cacheRead.toLocaleString()} tokens`,
    `- Estimated cost: $${u.costUsd.toFixed(4)} (local estimate, not a charge)`,
  ];

  sessionEvents.pushSynthetic(ctx.sessionId, {
    type: "assistant_message",
    streaming: false,
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: BigInt(Date.now()),
  } as ChatEvent);
};
