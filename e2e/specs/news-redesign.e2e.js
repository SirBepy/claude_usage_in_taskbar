// Integration coverage for the news redesign: the kebab ("more") menu and the
// in-app detail view that renders a cached AI summary.
//
// FREE: injects synthetic posts via the dev-only `window.__injectNews` seam
// (main.ts, stripped from prod builds). Post A carries a pre-cached `aiSummary`,
// so the detail view renders it WITHOUT calling `generate_news_summary` (which
// would spawn a real, billed `claude`). Post B's uncached summary path and the
// Regenerate button are deliberately NOT exercised here for the same reason.
//
// Opt-in:
//   npm run test:e2e:news

const POSTS = [
  {
    slug: "post-a",
    url: "https://www.anthropic.com/news/post-a",
    title: "Post A title",
    category: "Product",
    excerpt: null,
    summary: null,
    aiSummary: "Para one about what shipped.\n\nPara two about why it matters.",
    aiSummaryModel: "sonnet",
    aiSummaryAt: "2026-05-29T00:00:00Z",
    dateLabel: "May 5, 2026",
    dateIso: "2026-05-05",
    unread: false,
  },
  {
    slug: "post-b",
    url: "https://www.anthropic.com/news/post-b",
    title: "Post B title",
    category: "Announcements",
    excerpt: null,
    summary: null,
    aiSummary: null,
    aiSummaryModel: null,
    aiSummaryAt: null,
    dateLabel: "May 6, 2026",
    dateIso: "2026-05-06",
    unread: true,
  },
];

async function injectNews() {
  await browser.execute((posts) => {
    window.__injectNews(posts);
  }, POSTS);
}

describe("News redesign: kebab menu + detail view", () => {
  before(async () => {
    await browser.execute(() => window.showView("news"));
    await (await $(".view-news")).waitForExist({ timeout: 15000 });
    await injectNews();
    await (await $(".news-list .news-item")).waitForExist({ timeout: 10000 });
  });

  it("lists the injected posts", async () => {
    const items = await $$(".news-list .news-item");
    expect(items.length).toBe(2);
  });

  it("opens the kebab menu with the three actions, then closes on outside click", async () => {
    await (await $(".news-header-actions .icon-btn")).click();

    const menu = await $(".news-menu");
    await menu.waitForExist({ timeout: 5000 });
    const menuText = await menu.getText();
    expect(menuText).toContain("Mark all read");
    expect(menuText).toContain("Refresh");
    expect(menuText).toContain("Notify me on new posts");

    // Click outside the menu (the heading) -> document handler closes it.
    await (await $(".view-news h2")).click();
    await menu.waitForExist({ timeout: 5000, reverse: true });
  });

  it("opens the detail view and renders the cached AI summary", async () => {
    await (await $(".news-list .news-item")).click();

    const detail = await $(".news-detail");
    await detail.waitForExist({ timeout: 10000 });

    const paras = await $$(".news-summary p");
    expect(paras.length).toBe(2);
    expect(await paras[0].getText()).toContain("what shipped");
    expect(await paras[1].getText()).toContain("why it matters");

    // Both detail actions present (we do NOT click Regenerate: it would bill).
    const actionsText = await (await $(".news-detail-actions")).getText();
    expect(actionsText).toContain("Open original");
    expect(actionsText).toContain("Regenerate");
  });

  it("returns to the list when Back is clicked", async () => {
    await (await $(".news-detail .news-back")).click();
    await (await $(".news-detail")).waitForExist({ timeout: 5000, reverse: true });
    await (await $(".news-list")).waitForExist({ timeout: 5000 });
  });
});
