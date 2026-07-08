// @vitest-environment jsdom
// Drives the REAL add-account wizard module (openAddAccountWizard) against a
// mocked IPC layer, covering the browser-first flow (2026-07-08 reorder):
// step order, auto-advance, the credentials-already-present skip, the CLI
// fallback path, and the dismissal rules (no backdrop dismiss, X + confirm
// past step 1). The true side-effect boundaries (real Chrome window, real
// /login terminal) can only be crossed manually or by the wdio harness.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/shared/api.ts", () => ({
  api: {
    addAccountCreate: vi.fn(),
    addAccountCaptureCookie: vi.fn(),
    addAccountStartCliLogin: vi.fn(),
    addAccountCheckLogin: vi.fn(),
    addAccountCancel: vi.fn().mockResolvedValue(undefined),
    addAccountFinalize: vi.fn(),
  },
}));

import { api } from "../src/shared/api.ts";
import { openAddAccountWizard } from "../src/views/settings/subviews/accounts/add-account-wizard.ts";

const IDENTITY = {
  emailAddress: "joe@example.com",
  organizationUuid: "org-1",
  organizationName: "Joe's Organization",
  organizationType: "claude_max",
  profileFetchedAt: null,
};

function sessionResponse(overrides = {}) {
  return {
    session_id: "sess-1",
    config_dir: "C:/Users/x/.claude-test",
    adopted_existing: false,
    existing_identity: null,
    has_credentials: false,
    ...overrides,
  };
}

/** Flushes pending microtasks so awaited IPC mocks settle. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function stepLabels() {
  return [...document.querySelectorAll(".wz-steps .st")].map((el) => el.textContent.trim());
}

function currentStep() {
  return document.querySelector(".wz-steps .st.cur")?.textContent.trim() ?? "";
}

// Returns { done } (not the bare promise): an async fn's returned promise
// flattens, so returning the wizard's close-promise directly would make
// `await driveToCookieStep()` block until the wizard closes.
async function driveToCookieStep(createOverrides = {}) {
  api.addAccountCreate.mockResolvedValue(sessionResponse(createOverrides));
  const done = openAddAccountWizard([]);
  const name = document.querySelector("#aaw-name");
  name.value = "Test";
  name.dispatchEvent(new Event("input"));
  document.querySelector("#aaw-create-btn").click();
  await flush();
  return { done };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  // Close any wizard still open THROUGH ITS OWN X path (confirming the
  // discard if asked) so its document-level keydown listener is removed -
  // wiping the body directly would leak stale handlers into later tests.
  for (let i = 0; i < 5 && document.querySelector(".aaw-overlay"); i++) {
    document.querySelector("#aaw-close-btn")?.click();
    await flush();
    document.querySelector(".app-confirm-ok")?.click();
    await flush();
  }
  document.body.innerHTML = "";
});

describe("add-account wizard - browser-first flow", () => {
  it("shows the 4 steps with Browser login BEFORE CLI login", () => {
    void openAddAccountWizard([]);
    const labels = stepLabels();
    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("Create");
    expect(labels[1]).toContain("Browser login");
    expect(labels[2]).toContain("CLI login");
    expect(labels[3]).toContain("Finalize");
    document.querySelector("#aaw-close-btn").click();
  });

  it("Create advances to the browser-login step with both routes offered", async () => {
    await driveToCookieStep();
    expect(currentStep()).toContain("Browser login");
    expect(document.querySelector("#aaw-capture-btn")).not.toBeNull();
    expect(document.querySelector("#aaw-skip-browser-btn")).not.toBeNull();
    expect(api.addAccountCreate).toHaveBeenCalledWith("Test", null);
  });

  it("browser login with existing credentials skips the CLI step straight to finalize", async () => {
    await driveToCookieStep({ has_credentials: true });
    api.addAccountCaptureCookie.mockResolvedValue(IDENTITY);
    document.querySelector("#aaw-capture-btn").click();
    await flush();

    expect(currentStep()).toContain("Finalize");
    expect(api.addAccountStartCliLogin).not.toHaveBeenCalled();
    // Identity summary + label seeded from the step-1 name.
    expect(document.body.textContent).toContain("joe@example.com");
    expect(document.querySelector("#aaw-finalize-btn").textContent).toContain("Add Test");
  });

  it("browser login without credentials continues into the CLI step naming the account", async () => {
    await driveToCookieStep({ has_credentials: false });
    api.addAccountCaptureCookie.mockResolvedValue(IDENTITY);
    api.addAccountStartCliLogin.mockResolvedValue("Claude login - test");
    api.addAccountCheckLogin.mockResolvedValue({
      status: "Pending",
      misdirected: null,
      credentials_no_profile: false,
    });
    document.querySelector("#aaw-capture-btn").click();
    await flush();

    expect(currentStep()).toContain("CLI login");
    expect(api.addAccountStartCliLogin).toHaveBeenCalledWith("sess-1");
    expect(document.body.textContent).toContain("Claude login - test");
    // The wizard tells the user WHICH account to log into.
    expect(document.body.textContent).toContain("joe@example.com");
    document.querySelector("#aaw-close-btn").click();
    await flush();
    document.querySelector(".app-confirm-ok")?.click();
    await flush();
  });

  it("CLI login Ready auto-advances to finalize (no manual Continue)", async () => {
    await driveToCookieStep({ has_credentials: false });
    api.addAccountStartCliLogin.mockResolvedValue("Claude login - test");
    api.addAccountCheckLogin.mockResolvedValue({ status: "Ready", identity: IDENTITY });
    document.querySelector("#aaw-skip-browser-btn").click();
    await flush();

    expect(currentStep()).toContain("Finalize");
    expect(document.querySelector("#aaw-finalize-btn")).not.toBeNull();
  });

  it("a mismatched CLI login shows the failure card", async () => {
    await driveToCookieStep({ has_credentials: false });
    api.addAccountStartCliLogin.mockResolvedValue("Claude login - test");
    api.addAccountCheckLogin.mockResolvedValue({
      status: "Mismatch",
      existing_email: "web@x.com",
      new_email: "cli@x.com",
    });
    document.querySelector("#aaw-skip-browser-btn").click();
    await flush();

    expect(document.querySelector(".aaw-error").textContent).toContain("web@x.com");
    expect(document.querySelector(".aaw-error").textContent).toContain("cli@x.com");
  });

  it("finalize submits label/colour/icon and resolves with the account", async () => {
    await driveToCookieStep({ has_credentials: true });
    api.addAccountCaptureCookie.mockResolvedValue(IDENTITY);
    const account = { id: "acc-1", label: "Test" };
    api.addAccountFinalize.mockResolvedValue(account);
    document.querySelector("#aaw-capture-btn").click();
    await flush();

    const done = (async () => {
      document.querySelector("#aaw-finalize-btn").click();
      await flush();
    })();
    await done;
    expect(api.addAccountFinalize).toHaveBeenCalledWith("sess-1", "Test", expect.any(String), expect.any(String));
    expect(document.querySelector(".aaw-overlay")).toBeNull();
  });
});

describe("add-account wizard - dismissal rules", () => {
  it("backdrop click does NOT dismiss", () => {
    void openAddAccountWizard([]);
    const overlay = document.querySelector(".aaw-overlay");
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".aaw-overlay")).not.toBeNull();
    document.querySelector("#aaw-close-btn").click();
  });

  it("X on step 1 closes immediately without a confirm, resolving null", async () => {
    const done = openAddAccountWizard([]);
    document.querySelector("#aaw-close-btn").click();
    await flush();
    expect(document.querySelector(".app-confirm-overlay")).toBeNull();
    await expect(done).resolves.toBeNull();
    expect(document.querySelector(".aaw-overlay")).toBeNull();
  });

  it("X past step 1 asks; 'Keep going' keeps the wizard open", async () => {
    await driveToCookieStep();
    document.querySelector("#aaw-close-btn").click();
    await flush();
    expect(document.querySelector(".app-confirm-overlay")).not.toBeNull();
    document.querySelector(".app-confirm-cancel").click();
    await flush();
    expect(document.querySelector(".aaw-overlay")).not.toBeNull();
    expect(api.addAccountCancel).not.toHaveBeenCalled();
    // Clean up.
    document.querySelector("#aaw-close-btn").click();
    await flush();
    document.querySelector(".app-confirm-ok").click();
    await flush();
  });

  it("X past step 1 + 'Discard' cancels the backend session and resolves null", async () => {
    const { done } = await driveToCookieStep();
    document.querySelector("#aaw-close-btn").click();
    await flush();
    document.querySelector(".app-confirm-ok").click();
    await flush();
    expect(api.addAccountCancel).toHaveBeenCalledWith("sess-1");
    await expect(done).resolves.toBeNull();
    expect(document.querySelector(".aaw-overlay")).toBeNull();
  });

  it("Escape follows the same confirm rule as the X", async () => {
    await driveToCookieStep();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector(".app-confirm-overlay")).not.toBeNull();
    document.querySelector(".app-confirm-ok").click();
    await flush();
    expect(document.querySelector(".aaw-overlay")).toBeNull();
  });
});
