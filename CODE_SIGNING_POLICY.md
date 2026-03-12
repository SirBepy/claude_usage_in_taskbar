# Code Signing Policy

## Signed releases

Starting from v1.0.4, Windows installers for Claude AI Usage Toolbar are signed
using a certificate provided by [SignPath Foundation](https://signpath.org).

> Free code signing provided by [SignPath.io](https://signpath.io),
> certificate by [SignPath Foundation](https://signpath.org).

## Team

| Role | Member | Responsibility |
|------|--------|----------------|
| Author | SirBepy | Writes and merges all source code changes |
| Approver | SirBepy | Approves signing requests for releases |

No external contributors have merge or signing approval rights. All signing
requests are submitted automatically by GitHub Actions from the `master` branch.

## Signing scope

Only binaries built from this repository (`github.com/SirBepy/ai_usage`) are
submitted for signing. No third-party or modified upstream binaries are signed.

## Privacy

This application does not collect, transmit, or store any user data on external
servers. It reads your Claude AI usage data locally from the Claude website and
displays it in the system tray. No analytics, telemetry, or tracking of any kind
is included.

## Uninstallation

The application can be fully uninstalled via Windows Settings → Apps, or through
the original installer. All application data is stored in
`%APPDATA%\claude-usage-taskbar-tool` and can be manually deleted after
uninstallation.
