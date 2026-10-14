# Ask Jarvis — iPhone and Apple Watch setup draft v0.1

**Status:** Secret-free draft for Jarvis review, 14 October 2026. The S1 receiver URL, response schema, and device behavior are unverified. This is an action recipe, not an installable `.shortcut`. No iPhone or Watch was available for a live test. Do not put a credential in this file, a shared shortcut, an iCloud link, or a screenshot.

## What Tom will experience

Tap **Ask Jarvis**, speak a message, and wait for a short delivery receipt. “Sent” means the receiver confirmed that this request was accepted into real work, or that the *same request ID* already has real work. It does **not** mean Jarvis has answered. If the request times out or the receipt is unclear, the shortcut says **Delivery unknown**. It must never silently send the same message again with a new ID.

## Values to fill in after S1

| Placeholder | Meaning | Who supplies it |
| --- | --- | --- |
| `https://<PUBLIC_RECEIVER_ORIGIN>/api/routine-triggers/public/<PUBLIC_TRIGGER_ID>/fire` | Existing routine webhook route. Use the exact HTTPS webhook URL issued for the Ask Jarvis routine; no test endpoint. | Jarvis, after S1 confirms the receiver. |
| `<PRIVATE_BEARER_TOKEN>` | Credential for that route. Enter only on Tom's device after the flow is reviewed. | Jarvis arranges private insertion with Tom. |
| `<REQUEST_UUID>` | One random UUID v4 generated **once per dictated message**. | The shortcut. |
| `<RECEIPT_STATUS_KEY>`, `<RECEIPT_ID_KEY>`, `<RECEIPT_REQUEST_ID_KEY>` | Actual JSON receipt field names and accepted values. | Jarvis checks against S1. Never infer success from HTTP 202 alone. |

The intended body is `{"variables":{"text":"<trimmed dictated message>"}}`. `variables.text` is the pending S1 shape. The request UUID is in `Idempotency-Key`, not added to the body unless S1 explicitly requires it. The existing routine code generates URLs with `/api/routine-triggers/public/<publicId>/fire` and accepts JSON plus `Authorization` and `Idempotency-Key`; that does **not** establish the final S1 receipt contract.

## Build on iPhone: action-by-action

In **Shortcuts** on iPhone, create a shortcut named **Ask Jarvis**. Enter actions in this order. “Magic Variable” means selecting a previous action's output, not typing its visible name. Keep every placeholder literal until Jarvis confirms the receiver, then insert the private credential on Tom's device only. Apple documents [creating shortcuts](https://support.apple.com/guide/shortcuts/create-a-custom-shortcut-apd84c576f8c/ios), [action connections and Magic Variables](https://support.apple.com/en-ca/guide/shortcuts/apda850ab0e1/ios), [Dictionary actions](https://support.apple.com/en-lamr/guide/shortcuts/apd43b69f337/ios), and [POST JSON in Get Contents of URL](https://support.apple.com/en-az/guide/shortcuts/apd58d46713f/ios).

| # | Action and exact setup | Expected output / branch |
| --- | --- | --- |
| 1 | **Dictate Text**. Prompt: “What would you like to tell Jarvis?” Stop listening after a pause if that option is present. | Spoken text. If cancelled, stop; never send. Dictation on Watch needs a hardware test. |
| 2 | **Replace Text**. Input = Dictated Text; turn **Regular Expression** on; find `^\s+|\s+$`; replace with empty text. | Trimmed text. This removes leading/trailing whitespace without altering the message body. |
| 3 | **If** Trimmed Text **has no value** (or is empty on the installed OS), **Show Alert** “Nothing sent” / “No message was recorded. Try again when you're ready.”, then **Stop This Shortcut**. Close **End If**. | No request for blank or cancelled input. Verify the exact If comparator on device. |
| 4 | **Set Variable** `MessageText` = Trimmed Text. | Stable message value used by the body and any manual retry. |
| 5 | Build `RequestID` using the all-built-in UUID v4 recipe below. | One 36-character UUID for this invocation. Inspect its shape during setup. |
| 6 | **Dictionary** with one key `text` of type **Text**, value = `MessageText` Magic Variable. Set Variable `VariablesBody` = this Dictionary. | Inner object `{"text":"…"}`. |
| 7 | **Dictionary** with one key `variables` of type **Dictionary**, value = `VariablesBody` Magic Variable. Set Variable `RequestBody` = this Dictionary. | Outer object `{"variables":{"text":"…"}}`; Shortcuts handles JSON escaping. |
| 8 | **URL** = `https://<PUBLIC_RECEIVER_ORIGIN>/api/routine-triggers/public/<PUBLIC_TRIGGER_ID>/fire`. | HTTPS destination. Replace with the exact S1-issued routine URL. |
| 9 | **Get Contents of URL** with URL from #8. Expand options: Method **POST**; Request Body **JSON**. Populate the JSON body with the nested keys from #6–7 using Dictionary fields/Magic Variables; verify the action preview serializes `variables` as an object, not quoted JSON text. Headers: `Content-Type` = `application/json`; `Authorization` = `Bearer <PRIVATE_BEARER_TOKEN>`; `Idempotency-Key` = `RequestID` Magic Variable. | JSON receipt or an error. If the installed editor cannot bind the Dictionary output to JSON Request Body, recreate its two typed JSON fields inside this action; do not send a textified dictionary. Verify on iPhone before Watch. |
| 10 | **Get Dictionary from Input** = output of #9, then **Get Dictionary Value** for each S1 receipt key. | Parsed status, work ID, and echoed request ID. An unparseable or incomplete response is **Delivery unknown**. |
| 11 | **If** status matches S1's confirmed real-accepted value **and** a durable work ID is present **and** the echoed request ID matches `RequestID`, show **Show Alert** title “Sent”, body “Jarvis has your message. Request ID: [RequestID].” **Otherwise If** S1 explicitly reports a duplicate of the same request ID with a durable work ID, show the same “Sent” alert with body “Already received. Jarvis has this message. Request ID: [RequestID].” | “Sent” only for real accepted or same-ID duplicate work. If S1 omits an echoed ID, Jarvis must explicitly approve the alternate correlation rule before enabling this branch. |
| 12 | **Otherwise**, show the relevant state text from the table below. End If. No **Wait**, polling, second POST, or model-response step. | The shortcut ends after the delivery receipt. |

### Built-in UUID v4 recipe for action #5

Apple's documented built-in **Get Item from List** supports a random item; **Add to Variable** appends to an ordered list. A “Generate UUID” action may come from a third-party app, so this draft avoids assuming one is built in. This recipe is long; verify it on iPhone and Watch before release. [Apple list actions](https://support.apple.com/guide/shortcuts/use-list-actions-apd4dcacc115/ios); [Apple variable types](https://support.apple.com/guide/shortcuts/variable-types-apdd2b316022/ios).

1. Add **List** `HexAlphabet` with exactly 16 text items: `0`, `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`, `a`, `b`, `c`, `d`, `e`, `f`. Add **List** `VariantAlphabet` with exactly `8`, `9`, `a`, `b`.
2. For each segment below, add **Repeat** with the listed count. Inside it, add **Get Item from List** = **Random Item** of `HexAlphabet`, then **Add to Variable** named for that segment. After **End Repeat**, add **Combine Text** on that segment variable with **Custom** separator set to empty. Set the combined output to the named segment. Use fresh variables per segment, so no old characters are retained.
3. Segment A: repeat **8**, save combined text as `A`. Segment B: repeat **4**, save as `B`. Segment C: repeat **3**, save as `C`. Segment D: first **Get Item from List** = Random Item of `VariantAlphabet`, save as `Variant`; then repeat **3**, save as `D`. Segment E: repeat **12**, save as `E`.
4. Add **Text** exactly `A-B-4C-VariantD-E`, inserting the five segment values and Variant as Magic Variables, not typing their names. Thus the third group has `4` plus three random characters; the fourth has one of `8/9/a/b` plus three. **Set Variable** `RequestID` to this Text output. Expected shape: `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx` with lowercase hex. Never regenerate it for a retry of the same message.

This creates 122 random bits in UUID v4 positions if each random list selection is uniform. Its actual random selection behavior and action availability on Tom's OS remain to be tested. If any step fails on Watch, do not replace it with date-only or a per-run random number that does not meet the receiver's UUID contract; ask Jarvis to arrange a tested alternative.

## Receipt and error copy

S1 must define the exact JSON field names/values. The rows below are the user-visible rule, **not** a claim that the current routine route emits these strings. The current route can return `test_received`, `ignored`, `issue_created`, `coalesced`, or `skipped`; `issue_created` with linked work is a possible accepted case, while `coalesced` and `skipped` require product review because they may not create work for this message.

| State established by the verified S1 receipt | Display | Next action |
| --- | --- | --- |
| Real accepted work, correlated to request ID and durable work ID | **Sent** — “Jarvis has your message. You can close this now.” | End. A model reply will appear elsewhere later. |
| Same-ID duplicate with the same durable work ID | **Sent** — “Already received. Jarvis has this message.” | End. No second POST. |
| Test-only receipt | **Test only** — “The connection test reached Paperclip. No message was sent to Jarvis.” | Stop; Jarvis fixes setup. |
| Queued but no durable accepted work confirmation | **Queued** — “Your request is waiting. Delivery is not confirmed yet.” | Stop. Jarvis checks receiver receipt. |
| Rejected by auth, validation, disabled trigger, or explicit failure | **Not sent** — “The service rejected this message. Ask Jarvis to check the setup.” | Stop. Never show Sent. |
| Timeout, lost connection, unparsable/absent receipt, or ambiguous 202 | **Delivery unknown** — “We couldn't confirm delivery. Do not tap again for the same message yet. Ask Jarvis to check request [RequestID].” | Stop. A timeout does not prove failure. |
| Empty/cancelled dictation | **Nothing sent** — “No message was recorded.” | Stop before UUID or network request. |

**Retry rule:** The current one-tap Watch flow holds `RequestID` only within a single invocation. It cannot safely reuse that ID after the invocation ends or the network action times out. Therefore it has **no automatic retry button, loop, or second POST**. A new tap creates a new request ID and could create duplicate work. Jarvis must reconcile the unknown request in the receiver before asking Tom to send the message again. A future retry feature needs a tested durable message + request ID store and a receipt lookup; do not infer safety from idempotency alone.

## Private setup and Watch checks

1. Jarvis confirms S1's HTTPS URL, Bearer auth scheme, JSON body, receipt keys and values, and whether the receiver echoes request ID and durable work ID. Use a dummy token for any shared draft. Tom inserts the real token only in his local shortcut, away from screenshots and screen sharing. Do not share/export that configured shortcut or publish an iCloud link. If Shortcuts sync is enabled, Jarvis and Tom should check Apple's sync behavior before insertion.
2. Run on **iPhone first** with a harmless test message. Respond to iOS prompts for microphone/dictation and network access when they appear. If permission was denied, use the shortcut's Details/privacy settings and iOS Settings to restore access. Verify raw receipt through a private local inspection, then remove any diagnostic actions that display the token or full payload. Apple documents [Shortcuts privacy settings](https://support.apple.com/guide/shortcuts/adjust-privacy-settings-apd961a4fc65/ios).
3. In the shortcut's **Details** on iPhone, turn on **Show on Apple Watch**. Confirm **Ask Jarvis** appears in the Watch Shortcuts app. Apple documents the [Show on Apple Watch steps](https://support.apple.com/guide/shortcuts/run-shortcuts-from-apple-watch-apd5888b0858/ios).
4. Test a real Watch tap with a harmless phrase, including dictation, JSON POST, the receipt alert, blank/cancel, and a network failure. Apple warns that microphone actions can open Shortcuts or complicate Watch execution; this recipe is **not Watch-qualified** until this is observed. iPhone success does not prove Watch success. [Apple Watch action limitations](https://support.apple.com/en-gb/guide/shortcuts/apd081d9d61f/ios).
5. Optional: edit a compatible Watch face and add a **Shortcuts / Run Shortcut** complication pointing to **Ask Jarvis**. Test the complication separately from opening the Shortcuts app. [Apple complication guide](https://support.apple.com/guide/watch/add-complications-to-the-watch-face-apd8d0b9c582/watchos).
6. Test connectivity in three modes: Watch near paired iPhone with Bluetooth; Watch on compatible Wi-Fi away from iPhone; and, only if Tom has a cellular Watch with an active plan, Watch on cellular away from iPhone/Wi-Fi. Record whether the Watch itself completes the POST and shows a confirmed receipt. A private/LAN receiver may fail on cellular even if nearby mode works; S1 must supply a reachable HTTPS origin. Apple explains [Watch Bluetooth, Wi-Fi and cellular selection](https://support.apple.com/en-gb/109319) and [Wi-Fi limitations](https://support.apple.com/guide/watch/connect-apple-watch-to-a-wi-fi-network-apdff5efc8fb/watchos).

### Hardware test record for Jarvis

| Check | Result to record |
| --- | --- |
| iPhone model/iOS; Watch model/watchOS; Shortcuts versions | Exact versions, not assumed compatibility. |
| Dictation and cancelled/blank input on each device | Prompt, result, whether any request was made. |
| UUID shape and stability through one POST | Redacted ID prefix/suffix only; no token. |
| Nested JSON and all three headers | Confirm in a private receiver log; redact Authorization. |
| Accepted, duplicate, test-only, queued, rejected, malformed, timeout | Exact receipt → exact displayed message; no false Sent. |
| Watch app and complication launches | Separate outcomes for each. |
| Near iPhone, Wi-Fi away, cellular away if available | Request accepted or exact failure per mode. |
| Timeout/retry safety | No automatic retry; same-message second tap warning understood. |

**Release gate:** Jarvis reviews this draft against Apple documentation and S1, then arranges physical installation and testing with Tom. No Linux-generated or unsigned shortcut is represented here as installable.
