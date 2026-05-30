import { describe, it, expect } from "vitest";
import {
  projectName,
  sessionSubtitle,
  statusPriority,
  stateTooltip,
  sortSessions,
} from "../src/views/sessions/sessions-helpers.ts";

function makeInstance(overrides = {}) {
  return {
    session_id: "abc123",
    pid: 1,
    cwd: "/home/user/my-project",
    project_id: "proj1",
    kind: "interactive",
    is_remote: false,
    started_at: "2026-05-08T10:00:00Z",
    transcript_path: null,
    bridge_session_id: null,
    name: null,
    ended_at: null,
    end_reason: null,
    busy: false,
    ...overrides,
  };
}

describe("projectName", () => {
  it("returns last path segment on unix paths", () => {
    expect(projectName(makeInstance({ cwd: "/home/user/my-project" }))).toBe("my-project");
  });
  it("returns last path segment on windows paths", () => {
    expect(projectName(makeInstance({ cwd: "C:\\Users\\joe\\my-app" }))).toBe("my-app");
  });
  it("handles trailing slash", () => {
    expect(projectName(makeInstance({ cwd: "/home/user/project/" }))).toBe("project");
  });
});

describe("sessionSubtitle", () => {
  it("returns instance name when set", () => {
    expect(sessionSubtitle(makeInstance({ name: "Fix auth bug" }))).toBe("Fix auth bug");
  });
  it("returns 'New chat' when name is null", () => {
    expect(sessionSubtitle(makeInstance({ name: null }))).toBe("New chat");
  });
  it("returns 'New chat' when name is empty string", () => {
    expect(sessionSubtitle(makeInstance({ name: "" }))).toBe("New chat");
  });
});

describe("statusPriority", () => {
  const unread = new Set(["unread-id"]);
  const noAttention = new Set();
  const attention = new Set(["attn-id"]);
  const noQuestion = new Set();
  const question = new Set(["q-id"]);

  it("returns 0 for a session needing permission (attention)", () => {
    expect(statusPriority(makeInstance({ session_id: "attn-id" }), unread, attention, noQuestion)).toBe(0);
  });
  it("attention wins over busy and external", () => {
    expect(statusPriority(makeInstance({ session_id: "attn-id", busy: true, kind: "external" }), unread, attention, noQuestion)).toBe(0);
  });
  it("returns 1 for a non-busy question (Claude waiting on user)", () => {
    expect(statusPriority(makeInstance({ session_id: "q-id", busy: false }), unread, noAttention, question)).toBe(1);
  });
  it("question sorts above busy", () => {
    const q = statusPriority(makeInstance({ session_id: "q-id", busy: false }), unread, noAttention, question);
    const b = statusPriority(makeInstance({ busy: true }), unread, noAttention, noQuestion);
    expect(q).toBeLessThan(b);
  });
  it("returns 2 for busy interactive", () => {
    expect(statusPriority(makeInstance({ busy: true }), unread, noAttention, noQuestion)).toBe(2);
  });
  it("busy wins over a stale question flag", () => {
    expect(statusPriority(makeInstance({ session_id: "q-id", busy: true }), unread, noAttention, question)).toBe(2);
  });
  it("returns 3 for unread not-busy interactive", () => {
    expect(statusPriority(makeInstance({ session_id: "unread-id", busy: false }), unread, noAttention, noQuestion)).toBe(3);
  });
  it("returns 4 for read not-busy interactive", () => {
    expect(statusPriority(makeInstance({ session_id: "other-id", busy: false }), unread, noAttention, noQuestion)).toBe(4);
  });
  it("returns 5 for external", () => {
    expect(statusPriority(makeInstance({ kind: "external" }), unread, noAttention, noQuestion)).toBe(5);
  });
  it("external wins over busy", () => {
    expect(statusPriority(makeInstance({ kind: "external", busy: true }), unread, noAttention, noQuestion)).toBe(5);
  });
});

describe("stateTooltip", () => {
  const noUnread = new Set();
  const withUnread = new Set(["abc123"]);
  const noAttention = new Set();
  const noQuestion = new Set();

  it("needs permission (attention)", () => {
    expect(stateTooltip(makeInstance({ session_id: "abc123" }), noUnread, new Set(["abc123"]), noQuestion)).toBe("Needs your permission - click to answer");
  });
  it("attention overrides busy", () => {
    expect(stateTooltip(makeInstance({ session_id: "abc123", busy: true }), noUnread, new Set(["abc123"]), noQuestion)).toBe("Needs your permission - click to answer");
  });
  it("external", () => {
    expect(stateTooltip(makeInstance({ kind: "external" }), noUnread, noAttention, noQuestion)).toBe("External session (read-only)");
  });
  it("working", () => {
    expect(stateTooltip(makeInstance({ busy: true }), noUnread, noAttention, noQuestion)).toBe("Claude is running");
  });
  it("question", () => {
    expect(stateTooltip(makeInstance({ session_id: "abc123", busy: false }), noUnread, noAttention, new Set(["abc123"]))).toBe("Claude asked a question - click to answer");
  });
  it("done unread", () => {
    expect(stateTooltip(makeInstance({ session_id: "abc123", busy: false }), withUnread, noAttention, noQuestion)).toBe("Claude responded - click to read");
  });
  it("your turn", () => {
    expect(stateTooltip(makeInstance({ busy: false }), noUnread, noAttention, noQuestion)).toBe("Done - your turn");
  });
});

describe("sortSessions", () => {
  const unread = new Set(["busy-id"]);
  const noAttention = new Set();
  const noQuestion = new Set();
  const working = makeInstance({ session_id: "busy-id", busy: true, started_at: "2026-05-08T09:00:00Z", cwd: "/p/beta" });
  const yourTurn = makeInstance({ session_id: "other-id", busy: false, started_at: "2026-05-08T07:00:00Z", cwd: "/p/gamma" });
  const external = makeInstance({ session_id: "ext-id", kind: "external", started_at: "2026-05-08T06:00:00Z", cwd: "/p/delta" });

  it("status sort: working first", () => {
    const sorted = sortSessions([yourTurn, working], "status", unread, noAttention, noQuestion);
    expect(sorted[0].session_id).toBe("busy-id");
  });
  it("status sort: a chat needing permission sorts above a busy one", () => {
    const attention = new Set(["other-id"]);
    const sorted = sortSessions([working, yourTurn], "status", unread, attention, noQuestion);
    expect(sorted[0].session_id).toBe("other-id");
  });
  it("status sort: a question sorts above a busy one", () => {
    const question = new Set(["other-id"]);
    const sorted = sortSessions([working, yourTurn], "status", unread, noAttention, question);
    expect(sorted[0].session_id).toBe("other-id");
  });
  it("name sort: alphabetical by project", () => {
    const sorted = sortSessions([working, yourTurn, external], "name", unread, noAttention, noQuestion);
    expect(sorted.map(s => projectName(s))).toEqual(["beta", "delta", "gamma"]);
  });
  it("recent sort: newest started_at first", () => {
    const sorted = sortSessions([yourTurn, working, external], "recent", unread, noAttention, noQuestion);
    expect(sorted[0]).toBe(working);
  });
});
