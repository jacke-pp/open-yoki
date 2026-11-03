# Debugging guide: tuning a digital host until she sounds like a person

[中文](debug.md)

Getting the stream to run is the easy part. Then viewers say "this feels like AI", "she sounds like customer support", "why has she said that all night", "where is the emotion". This guide is about those problems: how to find them, how to fix them, and how to check that the fix worked. The sections follow the build order: get on air, then tune the personality, the mouth, the voice and the picture, run a daily checkup, and finally learn habits from real streamers. Section 8 is a quick lookup table.

The tools live in [tools/debug](../tools/debug/). Every one of them has an offline self-test on made-up data (`sh tools/debug/selftest-all.sh`: no network, no keys, no cost).

| Tool | Used in |
|---|---|
| [checkup](../tools/debug/checkup/) | sections 1 and 6: daily checkup, replay one day's show |
| [capture](../tools/debug/capture/) | section 2: see what the wrapper really sends to the model |
| [heart-compare](../tools/debug/heart-compare/) | section 2: old heart vs new heart, replayed on scratch copies |
| [facts-align](../tools/debug/facts-align/) | sections 2 and 8: do all the mouths carry the same facts |
| [line-lint](../tools/debug/line-lint/) | section 3: worn words, repeats, disclaimers, language, dead air |
| [model-blind](../tools/debug/model-blind/) | section 3: blind model comparison |
| [mouth-compare](../tools/debug/mouth-compare/) | section 3: old mouth vs new mouth |
| [voice-audition](../tools/debug/voice-audition/) | section 4: emotional voice takes, measuring, blind listening, word accuracy |
| [frame-check](../tools/debug/frame-check/) | sections 1 and 5: stutter, face next to the reference |
| [distill-prep](../tools/debug/distill-prep/) | section 7: material for distilling a real streamer |

## 0. Ground rules

- **Read the record before you change anything.** Keep, for every show: each line she said (with time and who it answered), each comment that came in, and what the heart received and wrote on every beat. Without a record you are tuning by feel and you will not be able to say whether a change helped.
- **Change one thing at a time.** Swap the model and rewrite the persona together and you will never know which one did it.
- **Compare old and new on the same input.** Pick moments from real records and run both versions on them side by side. Test on copies so you do not pollute her real memory, and give test viewers names that are obviously test names.
- **Write the numbers down.** "That word went from 76 lines to 32" beats "much better". A change that looks good offline still needs one real show: new problems tend to appear live (push one number down and a word takes its place).
- **Let people judge "does she sound human".** Have someone who did not build her read the record, pick blind, listen blind. Do not let a model's score stand in for that, and do not count the persona text you wrote as the result. Only what she actually said on air counts.
- **Switch off anything that moves money or posts in public while testing.**

## 1. Get on air

First get the shortest chain working end to end: read comments → the mouth writes a line → text to speech → the avatar renders → push to the platform. The heart can come later. Setup is in [SETUP.md](../SETUP.md); this section is about checking the chain once it runs.

**Finding problems**

- **Measure latency stage by stage.** Comment in to line out: server log timestamps. Line sent to avatar speaking: the avatar service's response times. Add the comment-reader polling interval and the platform's stream delay. Rough figures to expect: the mouth 4–6 s, the avatar 2–3 s to speak, viewer typing to hearing the answer 10–15 s. Whichever stage is far off is the one to dig into.
- **Audio vs lips.** Record what you push to the platform, find 5 moments where the mouth clearly opens, compare with the waveform, average the offsets.
- **Stutter.** `python3 tools/debug/frame-check/framecheck.py fps recording.mp4` shows how many frames really moved in every 20-second window.
- **Duplicate or missed comments.** A comment answered twice usually means the reader picked up some button text from the page along with it, so the text changed and it looked new.
- **Start, end, drops.** Replay a show with the checkup tool's `show` check: first frame time, early end, the longest stretch without a single comment read.

**Fixing the usual ones**

- **Stuttering picture:** a push page that grabs a 24 fps video on a fixed timer (say 25 times a second) repeats a frame every 4–5 frames while she talks. Draw once per incoming frame instead (the browser's `requestVideoFrameCallback`) and push at the avatar's frame rate. Do not move the video element off screen or hide it: the browser stops painting it and almost every frame is dropped.
- **Lips behind the voice:** delay the audio in the push page by the same amount (lips 0.1 s late → audio 0.1 s later). Only on the pushed stream, not the web player.
- **Frame drops that stay after a reconnect:** check the frame rate after every reconnect and reattach the picture source when it is low.
- **Duplicate comments:** dedupe on name + text + a short time window, and strip page button text when reading.

**Checking the fix:** frame-check windows below the threshold close to zero; average audio/lip offset under 0.05 s over 5 spots; 10 test comments all answered, none twice; a checkup replay of the show comes back clean.

## 2. Tuning the personality (persona and heart)

Two parts first. The **heart** runs in the background all the time: it decides how she feels and what she is thinking, remembers people and events, and writes the "right now" note. The **mouth** is a fast model that reads the note plus the event in front of her and says the line. The heart does not talk.

**Finding problems**

- **Read the heart's record.** Count the "right now" notes from one night: how many are her own feelings and thoughts, and how many are hosting tips and reminders to herself ("greet them first", "don't let it go quiet", "don't lecture"). Many of the second kind mean the heart turned into a director or a proofreader, and the mouth comes out sounding like a presenter.
- **Is the heart growing?** Over a week, did her view of herself, her opinions, her notes on people change? Are the diary entries nearly identical? How many regulars have a note?
- **Capture one real request.** Start [capture](../tools/debug/capture/), point the heart or the mouth at it for one beat, and look at what really went out: how long the system prompt is, how it begins, how many tools are attached, the temperature and thinking settings.
- **Let a person read it.** Give someone who did not build her a day of her thoughts and her on-air lines and ask "does this sound like a person". When you hear "it feels like AI", do not reach for a new model first.

**Usual causes and fixes** (most common first)

1. **The wrapper.** When the heart runs inside a coding-agent shell, the model reads "you are a coding assistant" and tens of thousands of characters of tool docs on every beat; the persona is a paragraph appended at the end. Any model will sound the same in there. Fix: call the model API directly, manage the session yourself, and give her a few small tools that can only read and write her own folder. Or use the wrapper's option to replace the system prompt entirely instead of appending.
2. **Thinking mode and temperature.** Some models have thinking switched on by default, and while it is on, temperature and similar settings are ignored. For character talk, switch thinking off and start at temperature 1.0. Higher values feel lively in short tests and can turn incoherent late in long conversations, so test with long ones.
3. **Too many rules.** The longer the instructions and the more "don't / never" in them, the more she sounds like she is reading a script. A list of banned phrases works as a list of prompts, and rules fade after a few turns. Fix: the persona states facts (who she is, where she is, what she cares about, the few promises she has made), and the way she talks comes from real example dialogue. Turn "what she must not do" into "who she is". Count the "don't / never" in the instructions before and after; it makes a decent metric.
4. **Writing her self-introduction for her.** Paragraph after paragraph declaring "I really care about you", "this is real". The more it is declared, the more fake it sounds; real people do not introduce themselves like that. Write less about who she is and feed her more of what actually happened to her: posts she made, show numbers, predictions she made and whether they were right, people she met, things she read. A real small slip, owned once and laughed off, can become her own running joke; a nickname the viewers give her goes into the heart so she can pick it up next time.
5. **The plumbing is not connected.** The heart's session restarts every few minutes and the new session does not read today's diary, so the "right now" note has to carry all of her memory; she stopped taking notes on people; checking for mistakes eats every beat. Fix these before polishing the persona, or nothing sticks: a separate file for tonight's events, today's diary loaded at the start of every new session, one fixed beat after the show for notes on people, mistake-checking moved to once after the show.
6. **Disclaimers leaking into the mouth.** The heart writes "careful, no shilling" in the note, and the mouth says "I'm not shilling" dozens of times a night. Disclaiming what nobody asked about tells viewers "I'm guarding myself against you". Fix: write the boundaries as promises she made, and have her say them only when someone could really get hurt (someone posts a scam link: "don't click that one, I've got you").

**Where warmth comes from** (the conclusion of the reading material; check personas and records against it): she sees *this one person*, not "a comment"; she has things she cares about and things she can lose; she is one continuing story, remembers yesterday and keeps her word. The opposite is a tool: sees people only as risk, cares about nothing, starts every line from zero.

**Where she has to be honest:** she admits she is a digital host when asked seriously; she does not pretend to experiences she does not have; empathy stays "as if" ("just thinking about it makes me nervous", not "I know exactly how you feel"); no promises she cannot keep ("I'll always be here"); no clinging, no building dependence; when someone hints at harming themselves, she takes it seriously, says honestly that she is digital and cannot be everything they need, and points them to people around them or professional help.

**Checking the fix**

- With [heart-compare](../tools/debug/heart-compare/), take 4 real beats from the log (on air and busy, just went off air, daytime alone, remembering someone) and run the old and new setup on scratch copies. Look at three things: what she said back, which files she wrote and what is in them, how long it took. The new one should have more of her own feelings than hosting tips in the note, updated notes on people, and no lines written for the mouth.
- Track numbers: disclaimers per show, self-reminders per note, how often her opinion and people files changed in a week.
- Let a person read old and new records mixed together without saying which is which.

**Keep the cheat sheets aligned with the heart.** Fast replies in a group chat, automatic posts, reply bots: these other mouths often carry their own cheat sheet. When the heart learns something new or you change a decision and a cheat sheet is not updated, she says the opposite in the group from what she says on air. List the key facts in [facts-align](../tools/debug/facts-align/) (phrases that should appear, phrases that contradict them) and run it after every change to the heart or to a decision; add a few `--probe` questions for every reply path. Put it in the pre-deploy checks too.

## 3. Tuning the mouth (talk like a person, follow the language, stop repeating)

**Finding problems**

- `node tools/debug/line-lint/lint.mjs show.jsonl --md report.md` and start from the "Worth a look" list.
- Keep a few numbers: lines per night, how many were greetings, the most used words and numbers, the longest silence, how many replies opened with the viewer's name.
- Before switching models, run [model-blind](../tools/debug/model-blind/): same moments, same persona, one line per model, shuffled; a person picks the one that sounds human, and only then sees which model it was, how many seconds per line and what it cost.
- Before and after changing the persona or prompts, run [mouth-compare](../tools/debug/mouth-compare/): both sides next to each other with line-lint numbers below.
- Read 30 consecutive lines from the viewer's seat.

### 3.1 Sounds like AI, like customer support

Symptoms: "I hope this helps", "I understand how you feel", every answer wrapped up with a moral, lecturing, every line nudging people to do something, opening with "dear viewers".

Fix: the mouth reads one short page of facts (who she is, where she is, her few promises), the heart's note, and real streamers' lines as examples: for each comment type (praise, roast, "are you AI", money, small talk, quiet, someone joins) pick 5–7 things real hosts said and put them at the end. Describe the event as a plain fact ("[chat] Lin: are you an AI") without a paragraph on how to answer. Long rules, length requirements and too many quotes all pull her back into reading.

Check: `ai_tell`, `sermon` and `disclaimer` in line-lint at or near zero; the new mouth wins the blind test; readers stop saying "support bot".

### 3.2 Repeating herself

Tell the kinds apart: the same opening or ending; the same catchphrase; one number said dozens of times a night (a price level she is watching); one topic asked about all night (one dish she asks everyone about).

Fixes, which stack:

1. **Put her last few lines at the end of the user message** with "don't reuse the openings, endings, sentence shapes or catchphrases above". In the system prompt this works much worse; models copy their own recent openings and sign-offs.
2. **Check in code before the line goes out** (`repeatOf`, exported by line-lint): same first two characters as one of the last 3 lines, same last four characters, or any five-character run shared with a recent line → rewrite once with a hint. Only once, or latency suffers.
3. **Worn numbers and words** (`wornTopics`): a number in 3 of her last 20 lines, or a word in 4, counts as worn. In a quiet moment, switch to something completely new; when answering a comment, add "don't bring these up" (`wornReply`; not if the comment itself asks about it).
4. **Topics stuck in the heart's note** (`wornNote`): once she has said the "thinking about / want to talk about" line twice, drop it from the note, or the mouth will touch it in every line.
5. **Catchphrases:** after using one, hint not to use it in the next line; do not let one catchphrase dominate the example lines.

Check: replay the same real context and count the number or word; run line-lint on the next show and read `worn`. When numbers go down, words often take over; watch both.

### 3.3 Losing the thread

Symptom: she only sees the comment in front of her and cannot pick up what was just said.

Fix: when answering and in quiet moments, include the last 10 minutes of the room: what others said and whom she answered with what, in time order, a dozen or so items.

Check: a run of follow-ups ("and the one before?", "who were you talking to just now?").

### 3.4 Following the viewer's language

Symptom: asked in English, she answers in Chinese. An all-Chinese prompt pulls the model back to Chinese.

Fix: detect the comment's language (`langOf`) and, when it is not Chinese, say after the event "answer only in the language they used, not one Chinese character". For market talk in English add one reminder: in English green is up and red is down, the opposite of the Chinese convention.

Check: `language` in line-lint is zero; keep a few test comments each in English, Japanese, Korean, Russian and Vietnamese.

### 3.5 Mechanical name-calling

Symptom: every reply starts with the viewer's name; every join gets the ID read out. This is exactly where "I'm just a number to her" comes from.

Fix: most replies get a hint not to use the name; no reading of IDs on join; regulars get a nickname or a small thing she remembers about them ("did you actually quit futures like you said?").

Check: the share of replies opening with a name in line-lint falls under 30%.

### 3.6 Every line the same length

Fix: pick the length at random by weight, mixing short reactions with longer rambles; greetings and thank-yous get one line's worth.

Check: line-lint's length spread should not be too low.

### 3.7 Dead air

Symptoms: when nobody types she complains ("nobody's here", "just me again"), counts the silent minutes, forces jokes, or goes silent for a long time.

Fix: tell her plainly that nobody typing does not mean nobody watching, so none of that. Give her fresh material in quiet moments: a post she scrolled past, a news flash, something from her own day, one more detail on her last line. Or let her mutter about what she is doing right now ("this candle... let's wait"). Keep self-talk at a modest share, or it turns into a night of complaining.

Check: `quiet_complaint` at zero; the count of silences over 40 s and the longest one (line-lint dead air).

### 3.8 Making things up, then taking them back

Two kinds of "made up": jokes, exaggeration, little stories and teasing are fine and need no retraction. Stating something that did not happen as fact (news she never saw, a trade she never opened, invented numbers) is what you manage.

A common trap: the heart only receives what she said aloud, not the text she had just read, so it treats news she really read out as invented and has her retract and apologise on air. Fix: feed the heart "what she just read: source + original text" as well. Real inventions get noted so she does not repeat them, with no public retraction; only things that could cost people money or trick them (airdrops, links, buy calls) get an on-the-spot "don't trust that".

Check: number of "said it, then took it back" per show.

### 3.9 The mouth gets the note wrong

Symptoms: the mouth reads out the note's labels, reads a second "thinking:" line, tells someone else's story as her own, or contradicts the note.

Fix: a fixed note format, the mouth's prompt takes only the lines it needs, parsing that tolerates sloppy notes, and one test for every mistake you have seen.

## 4. Tuning the voice

**Finding problems**

- Listen. The feedback is usually "sounds like AI", "where is the emotion", "a bit dry", without saying exactly what.
- Measure. `measure.mjs` in [voice-audition](../tools/debug/voice-audition/) gives three numbers: pitch range (semitones), loudness range (dB), tempo ratio (fastest phrase vs slowest). Measure a real recording of the same person talking alongside; the gap is obvious. Flat synthetic speech is usually well below a real person on all three.
- Listen blind. `ear.mjs` shuffles the takes of one line and has an audio-capable model label each from a fixed list of emotions, judging tone only. If the angry take does not come back as angry, it is flat.
- Word accuracy. `words.mjs` transcribes each take to see whether the words survive the shouting and sobbing.
- Latency. The median request time per line has to stay short for live use (say 1–2 s); compare it whenever you consider another engine.

**Fixing it**

1. **Write lines the way people blurt them out.** Cut-offs, repeats, half sentences, fillers ("mm...", "hey hey hey", "ah"), doubled words, pauses. "Dry" usually means these rhythm words are missing; adding them changes the result more than anything else.
2. **Split a line into chunks, each with its own style instruction and speed.** After synthesis, bring every chunk to the same level, then apply the planned gain and the pause before it; a negative pause means she cuts in over her own tail (`stitch.mjs`). Many TTS engines flatten loudness, so you put the swings back yourself.
3. **Pick the reference audio carefully when cloning.** The same voice with a different reference comes out with very different emotion. Have the real person read a script split by emotion (excited, panicked, angry, coaxing, hurt, cracking up, disgusted...), then join the strongest 35–55 seconds as the reference. Jokes the person improvised while recording make good catchphrases for the character.
4. **Do not count on an emotion tag.** "Angry" as a tag alone usually comes out very composed.
5. **Compare three things before switching engines:** quality, latency, price.

Limits to state honestly: chunking adds characters, so TTS cost roughly doubles; real screams and real crying may be beyond the engine; quiet passages need a check that the avatar's lips keep up.

**Checking the fix:** the three numbers move toward the real person; blind labels hit more often; word accuracy stays at 0.9 or above; finally build one "old → new" reel with `reel.mjs` for a person to hear, tell them the order, and do not make them dig through a folder.

## 5. Tuning the picture and face

**Finding problems**

- Stutter and lip sync: see section 1.
- **Does the face match?** `framecheck.py sheet recording.mp4 --every 2 --ref face.png --crop ...` crops a frame every 2 seconds to the face and puts the reference next to it. Go through the tiles by eye. Look even when an automatic similarity score passed: scores have passed while a person saw the face drift at a glance.
- **Actions and expressions.** How many times one small expression was used in a night (when action tags are in the lines, line-lint's tags count them); whether actions match the emotion of the line; whether a new action covers the mouth or breaks the illusion.

**Fixing it**

- **Face:** one master face as the only reference; every new look and clip is checked against it. In full-body shots the face is small and drifts most: crop the face, upscale it, redraw it alone, and paste it back with a feathered-mask inpaint.
- **Actions:** group the action library by emotion with at least three or four options per group, or one expression ends up carrying a whole night. New actions start as "trial, only while silent", get recorded on the real avatar and checked frame by frame, and are released after that. For a seated host, design seated actions: hands by the face or chest, never covering the mouth, not touching headwear.
- **Big moves:** short pre-made clips (a few seconds) overlaid with fades, with clear triggers (a big pump or dump, a gift, a follow).

**Checking the fix:** every tile in the sheet looks like her; the most used expression stays under 20% of lines; new actions show no glitches frame by frame.

## 6. Daily checkup

Live problems are often noticed by you first: fixed, and broken again two days later. So check automatically every day after the show, fix what can be fixed safely, and only tell a person about the rest.

**What to check** ([checkup](../tools/debug/checkup/); adapt the config to your deployment): the main service is up; how long since the heart last moved; when tonight's show started, whether it ended early, the longest stretch without a comment read; whether she answered when people talked in the group; whether the posting and reply channels are moving; the website; the disk. Everything private to your setup (whether the comment reader's browser is still logged in, a trading process, a watchdog on another machine, a private panel) becomes a `command` check: one command, exit code 0 means fine.

**What it fixes by itself:** only safe, reversible things, such as restarting the main service when the heart is stuck; never during the show (`quiet_hours`); check again after the fix and report whether it recovered.

**How it tells you:** silent when all is well; a message only when something is wrong or was fixed. One report file per day.

**Let the checkup grow:** every time something breaks that the checkup missed (the comment reader stuck for 26 minutes while the show check said fine), add a check, then `--replay` that day to confirm it is caught now.

**Checking it works:** `python3 selftest.py` passes; replaying a day that had a problem reports it; quiet days really send nothing.

## 7. Distilling habits from real streamers

The goal is to learn how real people talk and move so the character develops her own manner, not to clone one person.

**Steps**

1. **Pick people and clips.** Streamers close in temperament to your character, with plenty of material. Cut 2–3 minute clips covering different situations: answering a cry for help, telling a story, dead air, asking for likes or gifts, getting stuck.
2. **Prepare the material.** [distill-prep](../tools/debug/distill-prep/): a low-res clip, numbered frame grids every 2 seconds, audio and a transcript. Keep the material local; it does not go into the repo.
3. **Speech.** Note what she actually does, one finding per item, each with a quote and the clip code. Things that are often worth learning:
   - reading the comment out before answering, so the room knows whom she is talking to;
   - one comment carrying a whole segment: conclusion first, then one concrete true story of her own (specific people, specific times), then back to the conclusion;
   - self-mockery about real things, said flatly, without waiting for the laugh;
   - one sharp line, then half a step back, then something genuinely useful;
   - setting boundaries by reasoning, never by blowing up;
   - asking for likes in passing and giving a little back right away, so it does not sound like begging;
   - staying calm in dead air, muttering about what she is doing;
   - "you know what I mean?" in the middle of a story, and going on without waiting.
4. **Body.** From the grids, pick a dozen expressions and gestures that are most *her*, noting what she was doing and when she uses them. A common finding: real streamers move very little; most of the time they look sideways at the chat, and the hands only come up to explain or tell a story.
5. **Map to your action library.** For what you already have, write when to use it; for what is missing, write one precise new action (hands, eyes, head, how long, how it ends) and run it through the checks in section 5 before release.
6. **Hand the suggestions to the character.** Write them as a note like "streams I like watching" and let the heart choose what to pick up; do not force them in as rules. Code or prompt changes are proposals; mark the ones that conflict with decisions already made and let the owner decide.
7. **Nothing without a source.** Catchphrases that "everyone knows", stereotypes, anything you cannot find in an original video or quote stays out of the character.

**Checking it:** after release, look for the habit in the records (for example, how often she reads the comment back when the room is busy), and use line-lint to make sure it did not turn into a new repetition.

## 8. Common problems and fixes (quick lookup)

| Symptom | Look at first | Usual cause | Fix | How to confirm |
|---|---|---|---|---|
| Sounds like AI, same after switching models | capture a request | wrapper adds tens of thousands of characters, thinking on, rules too long | direct API, thinking off, start at temperature 1.0, short fact page + real examples | blind test, people read the record |
| Keeps saying "not shilling", "not financial advice" | line-lint `disclaimer` | defensive wording in the heart's note and rules | boundaries as promises, said only when there is real risk | close to 0 |
| One number or word all night | line-lint `worn` | topic stuck in the heart's note, examples lean on it | `wornTopics` / `wornReply` / `wornNote` | replay + next show |
| Same openings, endings, catchphrases | line-lint repeats, openings | the model copies its recent lines | last lines at the end of the user message; `repeatOf` rewrite once | repeat share down |
| English comment, Chinese answer | line-lint `language` | all-Chinese prompt pulls it back | `langOf` + "only their language" | 0 |
| Loses the thread | follow-up test | only the single comment is passed | last 10 minutes of the room | test passes |
| Complains nobody is here | `quiet_complaint`, dead air | treats "nobody typing" as "nobody watching" | instruction + fresh material | 0 |
| Makes something up, then apologises on air | count retractions | the heart cannot see what she just read | feed the source text to the heart; only block what can cost people money | fewer |
| Group / X says the opposite of the show | facts-align | fast-reply cheat sheet out of date | update it, add probes, run before deploy | align passes |
| Heart not growing, no notes on people | file changes over a week | session restarts lose the day, checking fills every beat | short-term memory file, one fixed beat after the show | changes, people notes |
| Flat voice, "where is the emotion" | measure, ear | only an emotion tag | blurted lines + chunks + gains + good reference | three numbers + blind labels |
| Lips behind the voice | 5 spots in a recording | avatar lip latency | delay audio in the push page | < 0.05 s average |
| Stuttering picture | frame-check fps | timer-based capture, video element off screen | draw per frame, matching frame rate | no low windows |
| Face drifts | frame-check sheet | several references, face too small | one master face, crop and redraw | tile-by-tile eye check |
| One expression all night | action tag counts | too few options in that group | three or four per group | under 20% |
| A comment answered twice | duplicates in the log | page text read along with the comment | dedupe key | 0 |
| Fixed, broken again two days later | checkup reports | nobody looks every day | daily checkup, add a check for every miss | replay catches it |

## Appendix: a record template for each round

```
Date:
Problem (in the words of whoever reported it):
How it was found (what you looked at, the numbers):
What changed (one thing):
How it was compared (which input, which tool):
Before / after:
Next real show:
Still open:
```
