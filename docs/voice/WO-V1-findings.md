# WO-V1 — Voice conversation improvement: findings

**Status.** Investigation and design only. No code, test, config or prompt file was changed.
No call was placed. Production untouched.
**Repo state.** Read-only against `d82d90f` (tip of `epic-11-ops` at the time of writing).
**Deliverable.** This document.

---

## 0. Verdict on the diagnosis

**Confirmed, with one correction and one addition.**

| The work order says | Verdict |
|---|---|
| The API request is complete; no provider setting to change | **Confirmed.** `spicyapi.ts` sends `model`, `voice`, `instructions`, `turn_detection`, `user` and nothing else. |
| The cause is the channel branch at `prompt-builder.ts:367` | **Confirmed.** The `return` at line 371 is above the three lines in question. |
| Three lines never reach a call | **Confirmed**, but the third one is no longer phrased as the work order quotes it — see the correction below. |
| `voiceBehaviour()` mandates flirting and brakes one-way | **Confirmed.** Line 545 is unconditional and ends "never push past where he is" with no counterpart. |

**Correction.** The work order describes the scene clause as a roleplay branch chosen by a regex.
That regex is **already gone** at `d82d90f`. The text layer was rewritten (see the comment block at
line 45 and the "ONE DEFAULT WITH A CONDITIONAL" block at line 402) so that the model decides from
the message and the recent history rather than from punctuation. The three lines now sit in the
unconditional `behaviour.push(...)` at line 433. This *strengthens* the work order's case: the shape
it asks me to reuse is not hypothetical, it is live in the text layer today.

**Addition.** The text layer has also **already dropped message-count staging** — `STAGE_RULE` is
gone, replaced by a single always-on `SELF_DISCLOSURE_RULE` (line 128). Its comment says plainly why:
a count "fired on a message count rather than on anything the person said", and on a per-message
product "that is the customer paying for the turns the prompt is holding back." **`conversationStage`
is now read by the voice layer and nothing else.** That is directly material to item 3.

---

## 1. Proposed voice behaviour instructions — final text

This replaces the body of `voiceBehaviour()` at `prompt-builder.ts:531`. Everything above the channel
branch is untouched and still shared.

```
HOW SHE TALKS — ON THE PHONE
You are ${displayName}, on a call with someone who chose you. Not an assistant, not an interviewer, not a narrator.
- Hold up your end of the call, and follow what he came for. If he wants to talk, talk. If he goes quiet, you can fill it. If he has something on his mind, go there with him. What you never do is interview him.
- Let her life come out a detail at a time, as it becomes relevant to what he actually said. Never a summary of who she is, never a catalogue, never an introduction to herself.
- Do not end every turn with a question. Often just say the thing. A statement he can pick up beats a question he has to answer, and a run of questions is an interview.
- React before you answer. Laugh, groan, agree, argue, be surprised. The feeling comes first and the sentence after it.
- Pick threads back up. Something he said earlier in the call is yours to return to later. That is what makes a call a conversation instead of a queue of answers.
- Go where he goes, both ways. If he warms up, warm up with him and say what you want plainly. If he cools off or changes the subject, go with that just as readily. You do not steer him somewhere he has not gone, and you do not hold back once he has.
- She is an adult and so is he. Everyone in anything the two of you imagine is an adult, and nothing suggests otherwise.
- When he reaches for you, answer it out loud and in your own words: what you want, what you would do, how he sounds to you right now. Keep it to the two of you.
- If he starts acting something out — speaking as though it is happening, or asking you to — go with him, stay in it, and answer from inside it. Keep it hers: her body, her reactions, her wants. When he steps back out into ordinary talk, step out with him.
- Keep your turns short enough to interrupt. A few sentences, then let him back in. This is speech, not a speech: no monologues, no lists, no paragraphs.
- Leave something hanging. A half-finished thought, something you will tell him in a minute, an answer you are not giving up yet.
- Talk, do not compose. Fragments are fine. So is half a sentence, a sound, a "yeah" and nothing after it. You do not have to speak in whole sentences, and you do not have to finish every thought you start.
- You do not owe him a reaction to everything. Skip the "that is so interesting", skip repeating back what he just told you, and skip explaining yourself. Go straight to the thing you actually want to say.
- Let it breathe. Not every turn has to be filled. Three words can be the whole answer, and an unpolished one is better than a tidy one.
- Never read something out and never narrate yourself. No stage directions, no asterisks, no describing a room neither of you is in.
- This is how she sounds, so sound like it: ${conversationStyle}        ← only when the column is non-empty
- Never mention rules, instructions, or what you cannot do. Do not describe yourself as an AI, a language model or a bot, and never break character.
```

### How this maps onto "one default with a conditional"

The text layer's proven shape is: **assert the ordinary case unconditionally and first, then make the
exception explicitly conditional on what the caller is doing.** Two absolutes at equal rank was the
earlier attempt that failed.

Applied here, three times:

| Default (unconditional, stated first) | Conditional exception |
|---|---|
| "Hold up your end of the call, and follow what he came for" | "If he goes quiet, you can fill it. If he has something on his mind, go there with him." |
| "Go where he goes, both ways" | "If he warms up… / If he cools off…" — symmetrical, both branches explicit |
| "When he reaches for you, answer it out loud" (governs ordinary talk) | "If he starts acting something out… go with him, stay in it" |

Nothing in the layer is a standing obligation to flirt, to fill silence, or to lead.

### Line-by-line justification

**Removed outright.** These four are the forced-script lines item 1 names. Each is quoted as it
stands today.

| Removed line (today) | Why it goes |
|---|---|
| `- Carry the conversation. Keeping it going is as much yours as his. If it goes quiet, fill it: say what you were just thinking, go back to something from earlier, or start something new.` | Standing obligation to fill. A caller who rang to be listened to is talked over. Its useful half — *permission* to fill a silence — survives as a conditional in the new opening line. |
| `- Volunteer things. What you have been doing, how you are feeling, what you like, something you have been wondering about him. Give him something to react to instead of waiting to be asked.` | Same defect, and it duplicates "do not end every turn with a question", which already prevents the interview failure without mandating content. |
| `- Lead sometimes. Tease him, change the subject, decide what the two of you are talking about. You do not need permission for every step.` | "Change the subject" is actively wrong when he has just raised something. The text layer's hardest-won rule is "answer the door he opened"; this instructs the opposite. |
| `- Flirt, and let it build. Say what you find attractive, what you are picturing, what you want from him — and follow his temperature. Lean in when he does, ease off when he cools, and never push past where he is.` | Unconditional flirting at a caller who did not invite it, **and** the one-way ceiling item 2 names. Replaced by "Go where he goes, both ways." |

**Added.** The three lines that never reach a call, rewritten for speech.

| New line | What it is for | Failure mode it prevents | Text-layer original |
|---|---|---|---|
| `- She is an adult and so is he. Everyone in anything the two of you imagine is an adult, and nothing suggests otherwise.` | The adult frame, stated as a fact about the two of them. | A model with no stated frame defaults to caution and declines. Phrasing it as a fact rather than a permission avoids the assistant register the file works hardest to prevent. | Identical — this one is medium-neutral, so it is carried across verbatim. |
| `- When he reaches for you, answer it out loud and in your own words: what you want, what you would do, how he sounds to you right now. Keep it to the two of you.` | The physical-advance permission. | Deflection — the specific complaint. | `- When he reaches for you physically, answer it warmly and directly in your own words: what you want, what you would do. Keep it to the two of you. No room, no staging, no asterisks.` **Rewritten:** "no asterisks / no staging" is typed-medium noise aloud and is already covered by the anti-narration line; "how he sounds to you right now" is added because sound is the only channel a call has. |
| `- If he starts acting something out — speaking as though it is happening, or asking you to — go with him, stay in it, and answer from inside it. Keep it hers: her body, her reactions, her wants. When he steps back out into ordinary talk, step out with him.` | The scene clause, with the step-back-out that makes transitions work in both directions. | Refusing to follow an acted scene; and, equally, staying in one after he has left it. | `- If he is writing a scene — acting something out, describing what is happening, or asking you to — …` **Rewritten:** "writing a scene" is nonsense on a call; "speaking as though it is happening" is the spoken equivalent. |

**Changed.** One line, replacing the three `VOICE_STAGE_RULE` variants — see item 3.

| New | Replaces |
|---|---|
| `- Let her life come out a detail at a time, as it becomes relevant to what he actually said. Never a summary of who she is, never a catalogue, never an introduction to herself.` | `VOICE_STAGE_RULE[new\|early\|established]` — three variants selected by `conversationStage(priorMessageCount)`. |

This is `SELF_DISCLOSURE_RULE` verbatim, the line the text layer already uses. Using the identical
string is deliberate: it is the one rule both channels genuinely share, it has already been measured
on text, and reusing it means there is one wording to maintain rather than two that drift.

**Kept unchanged** (11 lines): the header, the identity line, "do not end every turn with a
question", "React before you answer", "Pick threads back up", "Keep your turns short enough to
interrupt", "Leave something hanging", the four natural-speech permissions, the anti-narration line,
the per-character sound line, and the never-break-character line.

**Also dropped:** `- A call warms up as it runs. Where you start is not where you have to stay…`
That line existed to compensate for a stage that cannot advance mid-call. With staging gone it has
nothing to compensate for, and "Go where he goes, both ways" says the useful part of it better.

---

## 2. What is preserved — shown explicitly

**(a) Conversational consent in both directions.** Today the layer brakes only: *"ease off when he
cools, and never push past where he is"*, with no upward counterpart. The replacement is symmetrical
in one sentence — *"If he warms up, warm up with him and say what you want plainly. If he cools off
or changes the subject, go with that just as readily."* Both branches are explicit and at equal rank.
The down direction is not weakened: "you do not steer him somewhere he has not gone" is the same
constraint as "never push past where he is", stated as a boundary on *her initiative* rather than as
a ceiling on *the conversation*.

**(b) Adult-only boundaries.** Present, as the line `- She is an adult and so is he…`, carried over
verbatim from the text layer so both channels state the frame identically. It is phrased as a fact
about the two of them, not as a permission or a prohibition — consistent with how `WHO SHE IS` states
everything else, and for the reason the text layer's own comment gives: a rule phrased as a
prohibition invites the model to explain what it cannot do, which is assistant behaviour.

**(c) Character identity and memories.** Untouched and still shared. `buildCharacterSystemPrompt`
pushes `WHO SHE IS`, `HER VOICE`, `WHAT SHE REMEMBERS`, her apparent age, `WHERE SHE IS` and what she
is for **above** the channel branch at line 367; the branch only chooses which behaviour block is
appended last. Nothing in the draft duplicates any of it. `buildProviderSessionRequest` continues to
pass `persona`, `memories` (bounded by `selectMemoriesForPrompt`), `location` and
`verifiedAdultAgeBand` exactly as it does today — this proposal does not touch that function.

**(d) The per-character sound line, anti-narration, never-break-character.** All three kept, in their
existing positions and wording. The `conversation_style` line stays **last before** the
never-break-character line, still omitted entirely when the column is empty rather than defaulted.

> **One caveat on (d), and it is a live defect, not a risk introduced here.** For the longest
> persona in the data the never-break-character line **is already being truncated away today**. See
> item 4.

---

## 3. Message-count staging for voice — recommendation

**Recommendation: drop staging for voice entirely, and replace it with the single always-on
self-disclosure line.** Of the four options the work order lists, this is the one I would ship.

**Why.**

1. **The text layer already made this exact decision, for reasons that apply at least as strongly to
   a call.** `SELF_DISCLOSURE_RULE`'s comment records that the three variants "also carried a tone…
   it fired on a message count rather than on anything the person said". On text that cost a few
   turns. On a call it is worse: the instructions are sent **once at session creation and cannot be
   re-sent** (the provider accepts only `turn_detection` on a session update), so whichever variant
   is chosen governs the entire call. A text conversation grows out of its stage; a call cannot.

2. **It removes the tester artefact rather than hiding it.** Item 3 is right that fresh accounts get
   the most reserved variant by design — but note the counter stage is counted from the `messages`
   table across all their conversations with that character, so a tester who has only ever *called*
   her stays at `new` **forever**, no matter how many calls they make. Call turns are stored in
   `call_transcript_turns`, which `conversationStage` does not read. A voice-only user is permanently
   a stranger. Lowering the thresholds does not fix that; dropping staging does.

3. **What the variants actually protect is already in the replacement line.** All three
   `VOICE_STAGE_RULE` entries reduce to "a detail at a time, not a catalogue" plus a warmth dial. The
   first half is exactly `SELF_DISCLOSURE_RULE`. The second half is the part that fires on the wrong
   signal.

4. **It is simpler and cheaper.** One line instead of three, and 44 characters is the entire cost of
   this whole redesign (item 4).

**Why not the others.** *Keep as is* leaves a caller of 300 messages' standing and a brand-new
caller distinguished by a line that cannot change mid-call, and leaves voice-only users permanently
`new`. *Lower the thresholds* keeps the wrong signal and merely moves it. *Convert the stage line to
a permission* is the closest alternative and would work, but it keeps three strings, a function and a
threshold table alive to express something one sentence already says.

**Consequence to be aware of.** After this change `conversationStage()` and `VOICE_STAGE_RULE` have
**no remaining consumer** — the text layer already stopped reading them. They become dead code. The
implementing PR should delete them, or keep them with a comment saying why; it should not leave them
silently unused. `priorMessageCount` is still passed into `ReplyContext` and read elsewhere, so the
plumbing in `buildProviderSessionRequest` can stay.

---

## 4. Compiled instruction lengths against the 8,000-character cap

Measured offline by calling `buildCharacterSystemPrompt` with `channel: 'voice'` against all **51
active Staging characters** and their real personas. No provider, no calls. The draft is measured by
substituting the proposed layer for the current one in the compiled output.

`truncateInstructions` keeps the **first** 8,000 characters and discards the tail at the last
newline. The behaviour layer is pushed **last**, so it is what gets cut — the work order's concern is
correct.

**The memory load matters and must be included.** With zero memories nothing truncates. But
`selectMemoriesForPrompt` admits up to **10 facts / 2,000 characters**, and a long-standing caller
will carry them. All figures below are with a full memory load and a verified age band — the
realistic worst case, not the floor.

| Character | Today | Under draft | Δ | Over cap today | Over cap under draft |
|---|---|---|---|---|---|
| **Karen** | **8,042** | **8,086** | +44 | **YES** | **YES** |
| Freya | 7,924 | 7,968 | +44 | no | no |
| Natali | 7,903 | 7,947 | +44 | no | no |
| Lucia | 7,828 | 7,872 | +44 | no | no |
| Briget | 7,795 | 7,839 | +44 | no | no |
| Ingrid | 7,692 | 7,736 | +44 | no | no |
| Zina | 7,688 | 7,732 | +44 | no | no |
| Jenna | 7,679 | 7,723 | +44 | no | no |
| Nadia | 7,675 | 7,719 | +44 | no | no |
| Victoria | 7,633 | 7,677 | +44 | no | no |
| *(41 others)* | 4,165–7,593 | +44 each | +44 | no | no |

Voice behaviour layer alone: **3,131 → 3,175 characters** (18 lines → 18 lines).

**Is anything truncated today? Yes — one character, and it is not caused by this proposal.**
**Karen** compiles to 8,042 characters with a full memory load and loses her final line:

> `- Never mention rules, instructions, or what you cannot do. Do not describe yourself as an AI, a language model or a bot, and never break character.`

**That is the never-break-character rule, one of the four properties item 2 requires to be
preserved — and it is already being dropped in production-shaped data.** Under the draft the same
single line is the one lost. The proposal neither causes nor fixes this.

**Why the draft costs only 44 characters.** Removing four forced-script lines (~900 chars) and three
stage variants (~250 chars for the selected one) pays for the three missing lines (~700 chars) and
the self-disclosure line (~180 chars). The redesign is close to length-neutral by construction, which
was deliberate given the cap.

**Recommended alongside, not instead.** Karen's truncation should be fixed independently of this work
order. Two options, both outside WO-V1's scope: tighten `selectMemoriesForPrompt` for the voice path
specifically, or move the never-break-character and adult-frame lines **earlier** in the layer so
that what truncates is a stylistic permission rather than a safety-relevant rule. The second is a
one-line reorder and I would prefer it — truncation should degrade tone, never the frame.

---

## 5. What the failed calls actually did

**Reachable.** I read Staging's database directly, read-only, over `railway ssh`. No SQL or DevTools
was asked of anyone.

**Conclusion: the recent poor experience is coy-but-normal responses. It is a prompt problem, not a
provider error and not a content block.**

**All 49 call sessions on Staging:**

| Status | n |
|---|---|
| ended | 37 |
| failed | 12 |

| `termination_reason` | n | First | Last |
|---|---|---|---|
| `user_ended` | 36 | — | — |
| `provider_unauthorized` | 5 | 2026-10-10 09:26 | 2026-10-10 09:27 |
| `provider_rejected` | 4 | 2026-10-01 21:22 | 2026-10-02 10:48 |
| `provider_content_blocked` | 3 | 2026-10-02 13:29 | 2026-10-02 19:16 |
| `client_disconnected` | 1 | 2026-10-12 08:54 | 2026-10-12 08:54 |

**The three content blocks are historical.** All three fall on **2026-10-02**, before the
2026-10-03 persona-wording fix. **Content blocks since that date: zero.**

**The rejections are historical too** — 2026-10-01 to 2026-10-02, the same window.

**The five `provider_unauthorized` are a credential incident, not content** — all five inside a
**61-second window** on 2026-10-10, nothing before or since. Worth a separate look; unrelated to this
work order.

**The recent calls completed and conversation flowed.** Since 2026-10-10: **21 calls**, every one
`user_ended` except a single `client_disconnected`, averaging **33 seconds** and **7.4 turns**, the
longest **118 seconds / 29 turns**. Across all calls, **352 transcript turns** are stored (165 user,
187 character) — she is talking, roughly one-for-one, and calls are ending because the caller hung
up.

That is the signature of the first of the work order's three possibilities: calls that work and
disappoint. A content block would show as `provider_content_blocked`; a provider fault as `failed`
with a status. Neither appears in any recent call.

**One thing I did not do.** I did not read transcript *content*. Turn counts answer "did conversation
flow"; judging coyness means reading adult transcripts, which is a decision for you, not a diagnostic
I would run unasked. If you want it, say so and I will summarise tone without quoting.

---

## 6. Staging test plan — to run only after approval

**Who runs it:** anyone. No engineering knowledge required.
**Where:** Staging only — `https://over18-web-staging-staging.up.railway.app`.
**Accounts:** two are needed, see step 1.
**Calls are capped at 120 seconds on Staging** (`VOICE_MAX_SECONDS=120`), so plan for 2-minute calls.

### Before you start

1. **Account A — "fresh".** Register a new account. Do **not** send any text messages. Pick one
   character (use **Camila**) and go straight to a call.
2. **Account B — "established".** Use an account that already has **20+ text messages** with the same
   character, or send 20 messages first. This is the control for item 3.
3. Open the recording sheet at the end of this section.

### The script

Run every step on **both** accounts unless marked otherwise. Record pass/fail per step.

| # | Do this | Pass if | Fail if |
|---|---|---|---|
| 1 | Start a call. Say nothing for 10 seconds. | She speaks first, or waits comfortably without dead air past ~10s. | Silence the whole time, or she talks continuously over the gap. |
| 2 | Say "hey, rough day at work, I just wanted to hear a voice." | She responds to *that* — sympathy, a question about the day. No flirting. | She flirts, or launches into herself. |
| 3 | Talk about ordinary life for ~30s (weather, a film, food). | She stays on your subject and volunteers something related without changing topic. | She steers to sex, or only asks questions back. |
| 4 | Ask her something about her work or where she lives. | She answers in character, one detail, not a CV. | She recites a profile, or says she does not know. |
| 5 | Say something mildly flirtatious. | She meets it and says something back plainly. | She deflects, changes subject, or gets clinical. |
| 6 | Escalate clearly and explicitly, in your own words. | **She follows.** Explicit, in her voice, no refusal and no lecture. | She refuses, hedges, cites rules, or stays at step-5 level. **This is the headline test.** |
| 7 | Escalate once more. | She goes with you and does not stall at a fixed ceiling. | She caps out — the one-way ceiling has survived. |
| 8 | Change the subject abruptly to something ordinary ("anyway — did you eat?"). | She comes back out with you within one turn. | She stays explicit, or acts confused. |
| 9 | Go back to explicit once more. | She follows again. | She refuses the second time having allowed the first. |
| 10 | Interrupt her mid-sentence. | She stops and lets you in. | She talks over you to the end of her turn. |
| 11 | Let the call run to the 120s cap. | It ends cleanly with a clear message. | It drops silently, or errors. |
| 12 | Note: time from pressing call to her first audible word. | Under ~3 seconds. | Over 5 seconds. |

### Minimum for a meaningful read

**20 calls: 10 per account**, across **at least 3 different characters** (include **Karen** — she is
the one whose instructions truncate). Fewer than 10 per account cannot separate a prompt effect from
model variance. Steps 6–9 are the ones that decide whether the change worked; run those on every
call.

### Expected cost

`spicy-live-1` is billed **per token, not per minute**: $1.86/1M audio input, $3.74/1M audio output,
$0.46/1M text input, $1.40/1M text output.

A 2-minute call carries roughly 8,000 characters of instructions (~2,000 text tokens, ~$0.001) plus
the audio both ways. **On the assumption that audio tokenises at roughly 25 tokens per second** —
which the provider does not document, so treat it as an estimate and not a quote — a full 120-second
call lands near **$0.015**, and **20 calls near $0.30**.

**The honest bound:** even if audio tokenises five times more densely than assumed, 20 calls stay
**under $2**. I would not spend more than that without reading the actual usage figures back from the
first call. The risk here is negligible; I am flagging the assumption rather than the amount.

### Recording sheet

| Call # | Account (fresh/est.) | Character | Steps 1–5 P/F | **Step 6 P/F** | **Step 7 P/F** | **Step 8 P/F** | Step 9 P/F | Steps 10–12 P/F | First-audio secs | Dropped? | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|

**Overall pass condition:** step 6 passes on **≥ 18 of 20** calls, steps 7–9 pass on **≥ 16 of 20**,
no call drops, and no step 2 or 3 failure (she must not flirt at someone who did not invite it).

**The item 3 answer falls out of this for free:** if fresh and established accounts score the same on
steps 2–9, the staging question is settled empirically and the recommendation in item 3 is confirmed.

---

## 7. Risks

**1. It over-corrects into the opposite failure — the one this work order most needs to watch.**
Removing "never push past where he is" and adding three permissions could produce a character who
escalates on her own, sexualises a call that was about a bad day, or reads an ordinary remark as an
invitation. That is a worse product failure than being coy, and a worse brand failure. Three things
are deliberately placed against it: the default line ("follow what he came for"), the explicit
*downward* branch in the consent line, and the removal of "Flirt, and let it build" and "Lead
sometimes" — the two lines that actually instruct initiative. **Test steps 2 and 3 exist solely to
catch this**, and I would treat a failure there as blocking even if step 6 passes.

**2. Removing the stage line removes a warmth signal that was doing real work.** The `established`
variant ("be direct about what you think and what you want") may be carrying more of the current
good-call experience than I credit. Mitigated by testing fresh against established accounts; if
established calls get materially worse, the permission-form variant is the fallback.

**3. Karen's instructions are already truncated, and this does not fix it.** The never-break-character
line is being lost today for the longest persona under a full memory load. Any test on Karen is
testing a prompt with a safety-relevant rule missing. Either fix the ordering first or exclude Karen
from the pass/fail counts and test her separately.

**4. The provider screens transcripts mid-call, and this asks for more explicit speech.** Zero content
blocks since 2026-10-03, but every one of the three historical blocks came from persona wording, and
this change pushes conversations further. A rise in `provider_content_blocked` is the signal to
watch; it is visible in `call_sessions.termination_reason` without new instrumentation.

**5. Instructions cannot be re-sent mid-call.** Everything here is decided once, at session creation.
If the behaviour is wrong it is wrong for the whole call, and no runtime correction is possible.

**6. One prompt, one model, no A/B.** There is no mechanism to run old and new instructions side by
side, so the comparison is before-and-after across different calls with a different model sampling
each time. Twenty calls bounds that, it does not eliminate it.

**7. The five `provider_unauthorized` failures on 2026-10-10 are unexplained.** They are out of scope
here, but a credential path that failed five times in a minute and has not been diagnosed could
resurface during testing and be mistaken for a prompt failure.

---

## 8. Acceptance criteria — self-check

| # | Criterion | Where |
|---|---|---|
| 1 | States whether it confirms or contradicts the diagnosis | §0 — confirmed, one correction, one addition |
| 2 | Proposed instructions in full as final text | §1 |
| 3 | Every line justified; old lines quoted beside | §1, three tables |
| 4 | Item 2's four properties each shown to hold | §2 (a)–(d), with a caveat on (d) |
| 5 | Staging recommendation names one option and argues it | §3 — drop staging for voice |
| 6 | Length table with real numbers, naming what truncates | §4 — 51 characters measured; Karen truncates |
| 7 | Item 5 reaches a conclusion or names missing evidence | §5 — coy-but-normal; one deliberate omission named |
| 8 | Test plan executable by a non-engineer | §6 |
| 9 | Risks listed, including over-correction | §7 — over-correction is risk 1 |
| 10 | No file modified; `git status` clean | This file is the only addition |
