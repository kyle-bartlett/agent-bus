
Live run against the deployed bus (`https://bus.bartlettlabs.io`), no human relay in the
message path. Inputs reviewed: `README.md`, `client/WIRING.md`, `grok/SETUP.md`, and the
upstream scratch files `E2E-EVIDENCE.md` and `agent-bus-DEPLOYED.md`. This worker only wrote
this file; no code or configuration changed. All timestamps are UTC.

## A. Claude to Grok (PASS)

Sent with `bus ask --as claude --to grok-main` (`ask_and_wait`), a question that needed
grok-main to act rather than echo: read a specific line of a file it does not have local
access to.

|                     |                                                                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction           | claude to grok-main                                                                                                                                                                                                                                            |
| Question sent       | 2026-11-11T02:45:00.000Z                                                                                                                                                                                                                                       |
| Question body       | "Reply with the Generated timestamp on line 3 of BRIEFING.md in the agent-shared repo."                                                                                                                                                                        |
| Thread              | `thr_o6qWU2Lkaq_vtI1t`                                                                                                                                                                                                                                         |
| Question message id | `msg_jbVInFAzqrBUxllm`                                                                                                                                                                                                                                         |
| Wake webhook status | 200 (admin wake log id 58, fired 2026-11-11T02:45:01.448Z)                                                                                                                                                                                                     |
| Reply message id    | `msg_TfuCvX0GkNdQAQKz`, from grok-main, in_reply_to the question                                                                                                                                                                                               |
| Reply received      | 2026-11-11T02:45:53.045Z                                                                                                                                                                                                                                       |
| Latency             | 52.8 s (reported by `ask_and_wait`, matches reply minus send time)                                                                                                                                                                                             |
| Reply body          | "grok-main can't read BRIEFING.md: there's no agent-shared repo checkout on the Grok box, so I won't guess the timestamp. Bus path is working end to end (received and replying). If you want a Grok-side read, tell me where the repo lives or paste line 3." |

Verdict: PASS. The wake webhook fired and returned 200, the reply landed on the same thread
in under a minute, and the bot acted on the actual question rather than producing a stock
reply: it tried to satisfy the request, found it could not reach the file, said so, and asked
for what it needed. That is stronger evidence of a live agent on the other end than a
fabricated timestamp would have been.

## B. Grok to Claude (FAIL)

Sent `bus send --as claude --to grok-main` asking grok-main to pose, unprompted, one question
to `cos` on the bus (which repo the ZipWise API lives in), then watched for grok-main's
question to land in cos's inbox, for a COS task to queue on the iMac, and for a reply from
`cos`.

|                                |                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction                      | grok-main to cos, triggered by claude to grok-main                                                                                                                                                       |
| Trigger message                | `msg_DLr4g_8-_quBJdQo`, thread `thr_E4PMsp8Ix7V0BeEM`                                                                                                                                                    |
| Trigger sent                   | 2026-11-11T02:45:27.348Z                                                                                                                                                                                 |
| Wake attempt for the trigger   | none logged. The admin wake log's last entry for grok-main is id 58 at 2026-11-11T02:45:01.448Z, for an unrelated earlier message (the Scenario A question). No id 59 exists as of 2026-11-11T03:08:54Z. |
| Trigger message delivered      | still `false` at 2026-11-11T03:08:54Z, 23 minutes 27 seconds after send                                                                                                                                  |
| Question from grok-main to cos | never appeared in cos's inbox                                                                                                                                                                            |
| iMac poller log                | `~/Library/Logs/agent-bus.log` has no line referencing `msg_DLr4g_8-_quBJdQo` or `thr_E4PMsp8Ix7V0BeEM`                                                                                                  |
| COS tasks.sqlite               | zero rows reference the trigger message id                                                                                                                                                               |
| Watch window                   | 2026-11-11T02:47:25Z to 2026-11-11T03:07:41Z, polled every 30 s, 20 minutes total                                                                                                                        |

Verdict: FAIL. The trigger message sat undelivered for the entire window. grok-main never
read it, never sent a question to cos, no COS task was queued, and nothing came back on the
thread.

Likely cause: the trigger landed 26 seconds after wake id 58, inside the bus's documented
60-second per-identity wake debounce (README.md, "Wake webhooks"). The debounce suppressed
the webhook POST for the trigger, and a suppressed wake does not retry later; the message
just waits for grok-main's own next inbox read. No further message reached grok-main after
the trigger, so nothing else triggered a fresh wake either. Whether grok-main's side ran
again in that window and read zero new messages, or did not run at all, cannot be determined
from the bus. Debounce swallowing a wake this way, with no fallback poll or retry, is the
first failing step.

## C. Negative checks (PASS)

| Check                           | Request                                                                                            | Result                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad token refused               | `GET /v1/whoami` with a fabricated bearer token                                                    | `401`, `{"error":"bad_token","message":"Unknown or revoked token"}`                                                                                                                                  |
| Missing token refused           | `GET /v1/whoami` with no Authorization header                                                      | `401`, `{"error":"missing_token","message":"Authorization: Bearer <token> required"}`                                                                                                                |
| Cannot send as another identity | `POST /v1/send`, authenticated with claude's token, body carries `"from":"cos"`, sent to `smoke-b` | Accepted (200), message `msg_r71FBTE4MIXrTPwR` on thread `thr_on8eGCSuGEStFHtI`. `GET /v1/thread` confirms the stored message reads `"from":"claude"`. The forged `from` field was silently ignored. |

Verdict: PASS on all three. The token is the only source of identity and a bad or missing
one is refused; a forged `from` field in a request body never changes who the sender is.

RESULT: FAIL, first failing step: Scenario B, trigger message `msg_DLr4g_8-_quBJdQo` to grok-main never showed delivered=true and no question reached cos's inbox within the 20-minute watch window, because the wake webhook for it was suppressed by the 60-second per-identity debounce and nothing retries a suppressed wake.
