"use strict";

const { session: electronSession } = require("electron");

/** Removes all claude.ai cookies from the default Electron session. */
async function clearClaudeCookies() {
  const cookies = await electronSession.defaultSession.cookies.get({ url: "https://claude.ai" });
  await Promise.all(
    cookies.map((c) => electronSession.defaultSession.cookies.remove("https://claude.ai", c.name)),
  );
}

module.exports = { clearClaudeCookies };
