# Make the pasted-log sentinel collision-proof

## Goal
Ensure a pasted-log chip renders correctly even when the pasted body itself contains the literal string `</pasted-log>`.

## Context
Commit f918cf4 wraps large composer pastes in `<pasted-log name="...">BODY</pasted-log>` on send (`src/shared/chat/composer.ts`), and `chat-transforms.ts` (`PASTED_LOG_RE`, non-greedy `[\s\S]*?`) collapses it into a chip. If BODY contains `</pasted-log>`, the regex closes early and the remainder renders as raw text. Joe was offered this hardening and deferred it; not triggered by normal pastes.

## Approach
Pick one:
- Per-block random nonce in the tag: `<pasted-log id="<nonce>" name="...">...</pasted-log:<nonce>>` (nonce passed from composer to a matching regex). Note: workflow scripts can't use Math.random, but the composer is normal app code and can.
- Or base64-encode BODY inside the wrapper at send time so the body can never contain the delimiter; decode in `pastedLogChipHtml`. (Downside: Claude then receives base64, not readable text — violates "inline for Claude", so prefer the nonce approach.)

## Acceptance
Paste a blob whose text includes `</pasted-log>`; the sent message still renders a single chip and the lightbox shows the full original body intact.
