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

  it("returns 0 for busy interactive", () => {
    expect(statusPriority(makeInstance({ busy: true }), unread)).toBe(0);
  });
  it("returns 1 for unread not-busy interactive", () => {
    expect(statusPriority(makeInstance({ session_id: "unread-id", busy: false }), unread)).toBe(1);
  });
  it("returns 2 for read not-busy interactive", () => {
    expect(statusPriority(makeInstance({ session_id: "other-id", busy: false }), unread)).toBe(2);
  });
  it("returns 3 for external", () => {
    expect(statusPriority(makeInstance({ kind: "external" }), unread)).toBe(3);
  });
  it("external wins over busy", () => {
    expect(statusPriority(makeInstance({ kind: "external", busy: true }), unread)).toBe(3);
  });
});

describe("stateTooltip", () => {
  const noUnread = new Set();
  const withUnread = new Set(["abc123"]);

  it("external", () => {
    expect(stateTooltip(makeInstance({ kind: "external" }), noUnread)).toBe("External session (read-only)");
  });
  it("working", () => {
    expect(stateTooltip(makeInstance({ busy: true }), noUnread)).toBe("Claude is running");
  });
  it("done unread", () => {
    expect(stateTooltip(makeInstance({ session_id: "abc123", busy: false }), withUnread)).toBe("Claude responded - click to read");
  });
  it("your turn", () => {
    expect(stateTooltip(makeInstance({ busy: false }), noUnread)).toBe("Waiting for your input");
  });
});

describe("sortSessions", () => {
  const unread = new Set(["busy-id"]);
  const working = makeInstance({ session_id: "busy-id", busy: true, started_at: "2026-05-08T09:00:00Z", cwd: "/p/beta" });
  const done = makeInstance({ session_id: "busy-id", busy: false, started_at: "2026-05-08T08:00:00Z", cwd: "/p/alpha" });
  const yourTurn = makeInstance({ session_id: "other-id", busy: false, started_at: "2026-05-08T07:00:00Z", cwd: "/p/gamma" });
  const external = makeInstance({ session_id: "ext-id", kind: "external", started_at: "2026-05-08T06:00:00Z", cwd: "/p/delta" });

  it("status sort: working first", () => {
    const sorted = sortSessions([yourTurn, working], "status", unread);
    expect(sorted[0].session_id).toBe("busy-id");
  });
  it("name sort: alphabetical by project", () => {
    const sorted = sortSessions([working, yourTurn, external], "name", unread);
    expect(sorted.map(s => projectName(s))).toEqual(["beta", "delta", "gamma"]);
  });
  it("recent sort: newest started_at first", () => {
    const sorted = sortSessions([yourTurn, working, external], "recent", unread);
    expect(sorted[0]).toBe(working);
  });
});
