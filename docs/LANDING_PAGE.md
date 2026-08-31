# Landing page design brief

**Status: proposal, not yet built.** Written for review. Nothing in here is implemented.

The audience for the landing page is someone who was handed a link by the welcome team
thirty seconds ago and does not know what this app is. Everything below follows from
taking that person seriously.

---

## 1. What that person hits today

`HomePage` ([src/App.tsx:90](../src/App.tsx#L90)) shows a heading that reads **"Choose
Layout"**, a language dropdown, and three cards with wireframe diagrams. Four concrete
problems, in descending order of how badly they burn a real attendee:

### 1a. Choosing Haitian Creole silently gives you French

The homepage dropdown offers the three *text* translation languages
([configAtoms.ts:23](../src/configAtoms.ts#L23)). The listen code is derived from the
choice ([App.tsx:101](../src/App.tsx#L101)):

```ts
const listenCode =
  LISTEN_LANGUAGE_CODES.includes(LANGUAGE_BCP47[selectedLang])
    ? LANGUAGE_BCP47[selectedLang]
    : defaultListenCode(sourceLanguage);
```

`ht` is not in `LISTEN_LANGUAGE_CODES` — Gemini Live does not support Haitian Creole — so
it falls through to `fr`. A Haitian Creole speaker who picks their own language and taps
"Slide and Listen" gets Haitian Creole slides beside **French** audio and a **French**
transcript, with nothing on screen admitting the substitution.

The same class of bug exists in the other direction: `slideTranslation-{lang}` validates
against `languages` and falls back to `languages[0]`
([App.tsx:294](../src/App.tsx#L294)), so any listener whose language has no slide
translation would be shown French slides.

Both are the same root cause: **the UI offers a language without checking what that
language can actually do.**

### 1b. Two of the three doors lead to a blank wall

`slide-and-translation` and `slide-and-bilingual` ([App.tsx:65](../src/App.tsx#L65)) both
render `BilingualBlockViewerContainer`, which reads `sourceBlocks`. With note-taking off,
an attendee picking either gets a slide pane plus a permanently empty panel and concludes
the app is broken.

### 1c. English is unreachable from the landing page

The listen picker supports ~100 codes and pins English as a favorite, but the homepage can
only emit the three text languages. An English speaker who wants to read along has no path
from the front door — they would have to enter a foreign-language layout and then discover
the in-pane dropdown and know that "Original" means English.

### 1d. Operator links are in everyone's face

Note-Taker, Broadcaster, Review Slides, Status ([App.tsx:168](../src/App.tsx#L168)) — in
English only, unlabeled as staff tools, two of them leading to write-key prompts.

Plus, nothing on the page says what the app is, that translated audio in a shared room
needs headphones, or that arriving early means a legitimately empty screen.

---

## 2. The reframe

Under current scope (slides + live audio, note-taking off) there is essentially **one**
attendee destination. So the page should not ask for a layout. It should ask one question —
**"what language?"** — and route.

The read-vs-listen axis does not need to be a second question, because `ListenViewer`
already resolves it: the transcript renders unconditionally from Yjs, and audio is opt-in
behind the "Listen live" button ([ListenViewer.tsx:290](../src/ListenViewer.tsx#L290)).
Someone who only wants to read simply never presses it. The landing page's job is to *say*
so, so a reader does not assume audio is mandatory and give up.

**One question. One tap. One destination per language.**

---

## 3. Deployment configuration

### Where it comes from

`.env`, read by the server, served to the client at runtime — not `VITE_` build-time
constants. One Docker image, configured per deployment; baking NCF's language list into the
bundle would defeat that.

### How it reaches the client

`SessionGate` already blocks the whole app on `/api/session/current`
([SessionGate.tsx:24](../src/SessionGate.tsx#L24)). Fetch the config bundle in parallel
there, extending the existing `/api/config` ([server.ts:281](../server.ts#L281)).

- Parallel with the session fetch, so no extra wall-clock round trip.
- Inherits the gate's honesty: config failing gives a screen that says so, rather than a
  landing page silently rendering someone else's defaults.
- Additive for `install_proclaim_service.sh`, which reads only `posthogKey`/`posthogHost`.

### The items

```
SITE_NAME=New City Fellowship
SITE_LANGUAGES=en,fr,es,ht        # ordered; drives cards AND selector presets
FEATURE_NOTE_TAKING=off           # hides landing-page entries only
LIVE_AUDIO_SOURCE_LANGUAGE=en     # already exists — now also sent to the client
```

`FEATURE_NOTE_TAKING` is deliberately **presentation-only**. `/sourceText|bilingual-French#editor`
keeps working by URL, so a note-taker can still run one on a whim, and flipping the flag
back on is a single env change with no code path to re-verify. Worth a comment at the
definition so nobody later "hardens" it into enforcement.

`LIVE_AUDIO_SOURCE_LANGUAGE` already exists as deployment config but the client never sees
it. Before a broadcast starts, `liveAudioConfig` is unset and `useSourceLanguage()` falls
back to `DEFAULT_SOURCE_LANGUAGE = 'en'` ([liveAudioConfig.ts:36](../src/liveAudioConfig.ts#L36)).
Harmless at NCF; wrong on a Spanish-speaking deployment, where the landing page would label
the wrong card "Original" until someone hits Broadcast.

---

## 4. Deployment picks languages; code declares capabilities

The reason the existing selector presets are awkward to unify: today's four lists are not
the same set.

| List | Where | What it actually is |
|---|---|---|
| `languages` | [configAtoms.ts:23](../src/configAtoms.ts#L23) | text/slide translation targets, as display names |
| `LANGUAGE_BCP47` | [strings.ts:5](../src/strings.ts#L5) | name ↔ code map |
| `LISTEN_FAVORITES` | [listenLanguages.ts:35](../src/listenLanguages.ts#L35) | codes pinned in the listen picker |
| `SUPPORTED_LOCALES` | strings.ts | locales the UI is *actually translated into* |

Three of those are capability facts a deployment cannot change by env var. Gemini Live
supports `ht` or it does not. The UI has Haitian Creole strings or it does not. Only *which
languages this congregation cares about, in what order* is a deployment fact.

So: **one ordered `SITE_LANGUAGES`**, and each list above becomes that list intersected
with a code-owned capability table.

```
                        SITE_LANGUAGES = en, fr, es, ht          (deployment)
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
      LISTEN_LANGUAGE_CODES   LANGUAGE_BCP47    SUPPORTED_LOCALES   (code)
        "can hear it"        "can translate     "UI is written
                              slides into it"     in it"
                │                  │                  │
                ▼                  ▼                  ▼
          en fr es ─┐         fr es ht ─┐        en fr es ht
                    └──────────────┬────┘
                                   ▼
                      per-language capabilities
                      → card copy, and where the card goes
```

One ordered value gives you card order, `LISTEN_FAVORITES`, and the `languages` selector
list — without pretending a deployment can grant a capability it does not have.
`LANGUAGE_BCP47` stays code-owned and becomes the table you genuinely cannot derive.

### Where each card goes

| Language | Capabilities | Destination |
|---|---|---|
| `en` (= source) | audio + is the spoken language | `listen-en` — transcript is the point, audio one tap away |
| `fr`, `es` | audio + slide translation | `slideTranslation-{Name},listen-{code}` |
| `ht` | slide translation only | `slideTranslation-Haitian Creole`, card says "slides only" |
| `pt`, ~95 others | audio only | `listen-pt` alone |

Deriving the destination from capabilities is what kills both §1a bugs: a pane is never
rendered for a language it cannot serve.

**The `ht` row is the unhappy one.** Haitian Creole gets slides and no transcript at all.
Pairing it with a French transcript would be dishonest, so slides-only it is — but this is
the cell where the config model and the congregation's actual needs are furthest apart, and
it deserves a decision rather than a default (see §7).

---

## 5. Sketches

### 5a. Default, phone, NCF config

```
┌────────────────────────────────┐
│  New City Fellowship           │
│                                │
│  Live translation for today's  │
│  service. Pick your language.  │
│                                │
│  ┌──────────────────────────┐  │
│  │ English                  │  │
│  │ Read along, or listen    │  │
│  └──────────────────────────┘  │
│  ┌──────────────────────────┐  │
│  │ Français                 │  │
│  │ Diapositives et écoute   │  │
│  └──────────────────────────┘  │
│  ┌──────────────────────────┐  │
│  │ Español                  │  │
│  │ Diapositivas y escucha   │  │
│  └──────────────────────────┘  │
│  ┌──────────────────────────┐  │
│  │ Kreyòl Ayisyen           │  │
│  │ Dyapozitiv sèlman        │  │
│  └──────────────────────────┘  │
│                                │
│      ▸ Another language        │
│                                │
│  🎧 Headphones recommended     │
│     for audio                  │
│                                │
│  ─────────────────────────     │
│  More options                  │
└────────────────────────────────┘
```

Notes on this sketch:

- Language names are **endonyms** — each language named in itself, via
  `Intl.DisplayNames([code])` of the code. A Spanish speaker on an English-defaulted phone
  should see "Español", not "Spanish".
- The subtitle says what you actually get, in that language, so "slides only" for Kreyòl is
  visible *before* the tap rather than discovered as an absence afterward.
- Tapping a card also sets the UI locale where we have strings for it, so a French card tap
  from a borrowed English phone yields a French interface.
- No layout diagrams, no "Choose Layout", no operator links.
- "More options" is a quiet footer link (see §6).

### 5b. "Another language" expanded

```
┌────────────────────────────────┐
│  ◂ Back                        │
│                                │
│  ┌──────────────────────────┐  │
│  │ 🔍 Search                │  │
│  └──────────────────────────┘  │
│                                │
│  Afrikaans                     │
│  Akan                          │
│  Ayisyen → not available       │
│  Azərbaycan                    │
│  Bahasa Indonesia              │
│  Bosanski                      │
│  Català                        │
│  Čeština                       │
│  ...                           │
│                                │
│  Live audio only — slides are  │
│  translated into English,      │
│  French, Spanish and Haitian   │
│  Creole.                       │
└────────────────────────────────┘
```

The long list is `LISTEN_LANGUAGE_CODES` sorted by endonym. Everything here routes to
`listen-{code}` alone, and the footnote says why up front rather than letting someone
wonder where the slides went.

### 5c. Wide screen

The same content, centred and capped, cards in a two-column grid. No separate desktop
design — the page is four to six cards and a sentence.

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                  New City Fellowship                     │
│         Live translation for today's service.            │
│                   Pick your language.                    │
│                                                          │
│      ┌──────────────────┐   ┌──────────────────┐         │
│      │ English          │   │ Français         │         │
│      │ Read along, or   │   │ Diapositives et  │         │
│      │ listen           │   │ écoute           │         │
│      └──────────────────┘   └──────────────────┘         │
│      ┌──────────────────┐   ┌──────────────────┐         │
│      │ Español          │   │ Kreyòl Ayisyen   │         │
│      │ Diapositivas y   │   │ Dyapozitiv       │         │
│      │ escucha          │   │ sèlman           │         │
│      └──────────────────┘   └──────────────────┘         │
│                                                          │
│                  ▸ Another language                      │
│                                                          │
│           🎧 Headphones recommended for audio            │
│                                                          │
│  More options                                            │
└──────────────────────────────────────────────────────────┘
```

### 5d. With `FEATURE_NOTE_TAKING=on`

The flag adds a row; it does not restructure the page. Language stays the one question, and
the notes views become a second thing you *can* have in that language.

```
│  ┌──────────────────────────┐  │
│  │ Français                 │  │
│  │ Diapositives et écoute   │  │
│  └──────────────────────────┘  │
│              ...               │
│                                │
│      ▸ Another language        │
│                                │
│  ─────────────────────────     │
│  Sermon notes                  │
│    Translated · Side by side   │
│                                │
```

### 5e. What we are NOT doing

For contrast, the thing this replaces:

```
┌────────────────────────────────┐
│        Choose Layout           │   ← internal vocabulary
│                                │
│   Language: [ French  ▾ ]      │   ← 3 of ~100; ht silently → fr
│                                │
│  ┌──────────────────────────┐  │
│  │ ┌────┬────┐              │  │
│  │ │    │    │ Slide and    │  │   ← wireframe diagrams
│  │ └────┴────┘ Listen       │  │
│  └──────────────────────────┘  │
│  ┌──────────────────────────┐  │
│  │ ...  Slide and           │  │   ← empty pane (notes off)
│  │      Translation         │  │
│  └──────────────────────────┘  │
│  ┌──────────────────────────┐  │
│  │ ...  Bilingual View      │  │   ← empty pane (notes off)
│  └──────────────────────────┘  │
│                                │
│  Note-Taker | Broadcaster      │   ← staff tools, English only
│  Review Slides                 │
│  Status                        │
└────────────────────────────────┘
```

---

## 6. Deliberately out of scope

**A "build your own layout" page.** Most of it already exists: inside any layout the
per-pane selectors call `replaceComponent` and rewrite the URL
([App.tsx:406](../src/App.tsx#L406)), so languages can already be swapped live. The only
missing verb is adding or removing a pane.

For the uncommon combinations — English + slide, French listen-only — the "More options"
footer link should point at a short help page that spells out the layout URL grammar with
a few copyable examples. That serves the handful of people who want it at a fraction of the
cost, and if a particular example gets used a lot, that is the evidence for promoting it to
a real card. The one to watch: English speakers wanting the slide alongside the transcript.

**Operator links** move off the attendee flow entirely — a footer "Team" link, or
auto-revealed when `hasWriteKey()` ([writeKey.ts:114](../src/writeKey.ts#L114)) is true,
which is exactly the devices that should see them.

**Remembering the last language.** One tap is cheap enough that this is not worth the
shared-phone failure mode yet.

**The pre-service empty state.** Arriving early gives a gray dot, "waiting for speaker",
and a blank slide pane — which reads as failure to someone who has never seen it work.
Real problem, genuinely worth fixing, but it lives on the destination page, not here.

---

## 7. Open questions for review

1. **`SITE_LANGUAGES` order.** `en,fr,es,ht` assumed (spoken language first). Does the
   welcome team think of a different order?

2. **Haitian Creole's missing transcript.** Slides-only is the honest routing, but it is
   the worst-served language on the page. Alternatives: offer a French transcript beside
   Haitian Creole slides with an explicit label; or say plainly on the card that live audio
   is not available in Kreyòl. Neither is great. Your call.

3. **Card subtitles in languages we have no strings for.** UI strings exist for `en`, `fr`,
   `ht`, `es`. A Portuguese card in the long list can show its endonym but its subtitle
   would be English. Acceptable, or should the long list carry no subtitles at all?

4. **A misconfigured `SITE_LANGUAGES` entry** — a code that is neither a listen language
   nor a translation target. Drop it silently, or fail loudly at server start? Recommend
   failing loudly: a typo'd code that vanishes from the page is what gets noticed on a
   Sunday.

5. **`FEATURE_NOTE_TAKING` default.** `off` matches NCF today, but a fresh deployment
   getting note-taking hidden by default may surprise. Recommend defaulting **on** and
   setting `off` in NCF's `.env`, so the flag reads as "NCF turned this off" rather than
   "somebody must remember to turn this on".

6. **Showing the service date on the page.** Tempting, but `/api/session/current` returns a
   `docId`, and it is only `doc-YYYY-MM-DD` when `source` is `date` — a pinned session can
   carry any valid id ([sessionCurrent.ts](../src/sessionCurrent.ts)). Either parse it when
   it matches and omit it otherwise, or leave the date off. Leaning toward leaving it off.

7. **Display names are load-bearing.** Translation cache keys are `${language}:${content}`,
   and `slideTranslations` keys the same way. Renaming `"Haitian Creole"` → `"Haitian"`
   silently orphans every cached translation in every existing doc and re-bills the whole
   back catalogue. Whatever the central list ends up looking like, the display name has to
   stay a stable identifier — worth a comment saying so at the definition. Flagging in case
   the central-list refactor makes renaming look harmless.

---

## 8. Smoke test impact

Implementing this would touch [SMOKE_TEST.md](SMOKE_TEST.md) **§4 (live audio
translation)** — the entry path into the listen pane changes — and would want a new short
section covering the landing page itself: each configured language card reaches a working
destination, and no card offers a pane its language cannot serve.
