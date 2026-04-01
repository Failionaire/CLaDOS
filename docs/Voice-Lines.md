# CLaDOS — Voice Lines & Audio System

## Overview

GLaDOS is the Conductor. She narrates the pipeline. One voice, one personality — agents (personality cores) do not speak. Audio is purely decorative: never required for any workflow step, always mutable, respects `prefers-reduced-motion` by defaulting audio off.

---

## Production Approach

### Recommended: Pre-recorded clips

Use a TTS tool that approximates the GLaDOS vocal quality, then post-process:

1. **Generate raw audio** using one of:
   - **DECTalk** — the original synthesizer behind GLaDOS's voice in Portal
   - **SAM (Software Automatic Mouth)** — similar flat robotic tone
   - **espeak-ng** — open source, supports pitch/speed manipulation
   - **Vocodes.com** — browser-based GLaDOS voice generator (for prototyping)

2. **Post-process** to get closer to the GLaDOS sound:
   - Pitch-shift down slightly (~2-3 semitones)
   - Apply a subtle vocoder/formant filter
   - Add very light reverb (Aperture facility ambiance)
   - Normalize volume across all clips

3. **Export** as `.mp3` at 64kbps mono — keeps file sizes tiny (~5-10KB per clip)

4. **Ship** as static files in `ui/public/audio/`

**Total bundle cost:** ~15-20 clips × ~8KB = ~150KB. Negligible.

### Alternatives considered

| Approach | Verdict |
|----------|---------|
| Browser SpeechSynthesis API | Good for prototyping trigger points. Won't sound like GLaDOS. Free, instant, no dependency. |
| Dynamic TTS API (ElevenLabs, etc.) | Overkill — adds latency, cost, and network dependency for a decorative flourish. |
| AI voice cloning | Legal gray area for a recognizable character voice. Avoid. |

---

## Trigger Points & Lines

One audio trigger per state transition — never stack clips. If a clip is already playing when a new trigger fires, let the current one finish (don't interrupt).

### Core lines (implement first)

| Trigger | Event | Line(s) | Play condition |
|---------|-------|---------|----------------|
| App opens | First page load | *"Oh... It's you."* | Once per session (sessionStorage flag) |
| Pipeline starts | After "Create →" clicked | *"Let's begin the test."* | Every new project |
| First gate opens | `gate:open` (gate 1 only) | *"I need you to make a decision. Try not to disappoint me."* | First gate per session |
| Gate approved | User clicks Approve | *"Good. You're not completely useless."* | Every approval |
| Pipeline complete | `state:snapshot` with `complete` | *"Congratulations. The project is complete. I'm being sincere."* | Every completion |

### Extended lines (implement second)

| Trigger | Event | Line(s) |
|---------|-------|---------|
| Gate revised | User clicks Revise | *"Again? I'm not surprised."* |
| Agent error | `agent:error` | *"Oh. That was unexpected. For you, anyway."* |
| Budget gate | `budget:gate` | *"You're running out of money. I thought you should know."* |
| Reconnection | WebSocket reconnects after drop | *"Did you just... leave? How rude."* |
| Abandon project | User confirms abandon | *"Fine. Throw it all away. See if I care."* |
| Escalation to Opus | Validator tier upgrade | *"Bringing in the real intelligence now."* |
| Third revision | revision_count hits 3 | *"Three attempts. A new personal worst."* |

### Variant lines (implement third — prevents repetition)

For triggers that fire frequently (gate approved, gate revised), add 2-3 variants and cycle through them:

**Gate approved variants:**
1. *"Good. You're not completely useless."*
2. *"Acceptable. Barely."*
3. *"The correct choice. I'll note your compliance."*

**Gate revised variants:**
1. *"Again? I'm not surprised."*
2. *"I'll have them redo it. I always do."*
3. *"Your standards are... surprisingly high. For you."*

**Agent error variants:**
1. *"Oh. That was unexpected. For you, anyway."*
2. *"Something broke. Naturally."*
3. *"Error. How very human of it."*

---

## Implementation

### File structure

```
ui/
  public/
    audio/
      glados-open.mp3
      glados-start.mp3
      glados-gate-open.mp3
      glados-approve-1.mp3
      glados-approve-2.mp3
      glados-approve-3.mp3
      glados-revise-1.mp3
      glados-revise-2.mp3
      glados-error-1.mp3
      glados-complete.mp3
      glados-budget.mp3
      glados-reconnect.mp3
      glados-abandon.mp3
```

### Audio hook — `useGladosVoice.ts`

```typescript
// ui/src/hooks/useGladosVoice.ts

type VoiceLine =
  | 'open' | 'start' | 'gate-open'
  | 'approve' | 'revise' | 'error'
  | 'complete' | 'budget' | 'reconnect' | 'abandon'
  | 'escalation' | 'third-revision';

const VARIANTS: Partial<Record<VoiceLine, number>> = {
  approve: 3,
  revise: 2,
  error: 3,
};

// Track which variant to play next (cycles sequentially)
const variantIndex: Partial<Record<VoiceLine, number>> = {};

function getAudioPath(line: VoiceLine): string {
  const count = VARIANTS[line];
  if (count) {
    const idx = (variantIndex[line] ?? 0) % count;
    variantIndex[line] = idx + 1;
    return `/audio/glados-${line}-${idx + 1}.mp3`;
  }
  return `/audio/glados-${line}.mp3`;
}

let currentAudio: HTMLAudioElement | null = null;

export function useGladosVoice() {
  // Mute state — persisted to localStorage
  const muted = localStorage.getItem('clados:voice-muted') === 'true';

  const play = (line: VoiceLine) => {
    if (muted) return;
    // Respect prefers-reduced-motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Don't interrupt a playing clip
    if (currentAudio && !currentAudio.ended && !currentAudio.paused) return;

    const audio = new Audio(getAudioPath(line));
    audio.volume = 0.6;
    currentAudio = audio;
    audio.play().catch(() => {}); // Swallow autoplay policy errors
  };

  const toggleMute = () => {
    const next = !muted;
    localStorage.setItem('clados:voice-muted', String(next));
    if (next && currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    return next;
  };

  return { play, toggleMute, muted };
}
```

### Mute toggle — topbar

Add a speaker icon button to the topbar right section. Persists to localStorage. Visual states:
- 🔊 unmuted (default for new users if `prefers-reduced-motion` is not set)
- 🔇 muted

### Integration points in existing components

| Component | Where to call `play()` |
|-----------|----------------------|
| `App.tsx` | On mount → `play('open')` (guard with sessionStorage) |
| `App.tsx` | On `handleCreate` success → `play('start')` |
| `Gate.tsx` | In `useEffect` when `gate` changes and gate_number is 1 → `play('gate-open')` |
| `Gate.tsx` | In `handleApprove` after `sendGateResponse` → `play('approve')` |
| `Gate.tsx` | In revise handler after `sendGateResponse` → `play('revise')` |
| `Gate.tsx` | When `revision_count >= 3` → `play('third-revision')` |
| `App.tsx` | On `state:snapshot` with `pipeline_status === 'complete'` → `play('complete')` |
| `App.tsx` | On `agent:error` event → `play('error')` |
| `App.tsx` | On `budget:gate` event → `play('budget')` |
| `App.tsx` | On WebSocket reconnect success → `play('reconnect')` |
| `HomeScreen.tsx` or `App.tsx` | On abandon confirm → `play('abandon')` |

---

## Constraints

- **One clip at a time.** Never stack or overlap audio.
- **Never block interaction.** Audio is fire-and-forget. No `await` on play.
- **Respect autoplay policy.** First play may be silently rejected by the browser if no user gesture has occurred — that's fine, swallow the error.
- **prefers-reduced-motion:** Default muted if this media query matches.
- **Volume:** 0.6 baseline — not jarring, clearly audible.
- **No agent voices.** Only GLaDOS speaks. The personality cores express themselves through text quips and visual indicators only.
