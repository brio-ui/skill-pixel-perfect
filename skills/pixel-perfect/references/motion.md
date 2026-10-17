# Motion

How the skill measures motion, how grade.mjs judges it, and how to build motion that passes. The script contracts are in `scripts.md` and the gate numbers in `gate.md`.

## What is graded

Each motion entry in `plan.json` is traced on the original and on the clone at each of its widths, then compared sample by sample.

| Kind | Covers | Sampling starts | Default length |
| --- | --- | --- | --- |
| `load` | entrances that play when the page loads | when the network goes idle | 2000 ms |
| `scroll` | reveals that play when the section scrolls into view | when the section's top reaches 75% of the viewport height | 1500 ms |
| `hover` | the hover transition of a state's trigger | when the mouse reaches the trigger | 600 ms |
| `click` | what a click on a state's trigger starts | at the click | 800 ms |
| `loop` | infinite motion: marquees, spinners, pulses, autoplay carousels | after a warm-up of whole periods | 3000 ms |
| `scrub` | scroll-linked motion: parallax, sticky progress, scroll-driven animations | at scroll positions instead of times | 12 positions |

Samples are 50 ms apart (`GATE.motionStepMs`), so a 1500 ms trace has 31 samples. Every sample must match within 2 px (`GATE.motionPx`) on each of x, y, width and height, and within 0.05 opacity (`GATE.motionOpacity`). For `load`, `scroll`, `hover` and `click`, the motion must also start and end within 50 ms (`GATE.motionMs`) of the original's. Loops are compared at the time shift that fits best. Scrub entries are compared position by position.

The pixels inside canvas, WebGL, iframes and video are never graded. Their boxes are traced like any other element.

Each trace saves frames at 0, 50 and 100% for the report. They are for people reading the report. Do not open them: grade.json and capture.json hold every number a fix needs.

A second clone capture with `prefers-reduced-motion: reduce` checks that the clone stops moving when the user asks it to. See [Reduced motion](#reduced-motion).

## How a trace runs

Each trace gets a fresh page with the static capture's settings: device scale factor 1, a desktop user agent, en-US, UTC and the light color scheme. Before any page script runs, the page gets a fake clock paused at 2026-01-01 12:00:01 UTC, and the document timeline's playback rate is set to 0. Timers, `requestAnimationFrame`, `Date.now()` and `performance.now()` follow the fake clock. CSS transitions, CSS animations and Web Animations stay at their start. Nothing moves until the trace moves it, so the original and the clone run on the same time.

When the static capture closed a consent banner at that width, a throwaway page in the same browser context closes it first. The trace page then loads with the consent cookie set and no banner on top.

The page loads and the trace waits until the network is idle. The next steps depend on the kind.

### load

1. No warm-up. Sample 0 is the page right after loading, with every animation still at its start.
2. The section may appear during the trace. It only has to be found at some sample.

### scroll

1. At the top of the page, the fake clock runs 3 s so load entrances finish. The page then settles: finite animations finish, infinite ones are cancelled, videos pause on their first frame and focus is dropped.
2. The page scrolls in one jump so the section's top sits at 75% of the viewport height.
3. The trace waits up to 5 s of real time for images in the viewport, then 300 ms more so IntersectionObserver callbacks and scroll handlers run.
4. Sampling starts.

### hover and click

1. The page scrolls so the section's top is at the top of the viewport. When part of the trigger is still outside the viewport, the page scrolls to center it. Then 300 ms of real time pass.
2. The fake clock runs 3 s and the page settles, so reveals in view finish before the trigger runs.
3. The trace waits for images in the viewport.
4. The mouse moves to the trigger's center, and the trace waits in real time until the trigger matches `:hover`. A `click` entry then clicks there, so the hover and click effects start together.
5. After 300 ms of real time, sampling starts.

The trigger is the state's `selector` in the original and `[data-pp-trigger~="<state id>"]` in the clone. When something covers the trigger, the entry is missing with the note `hover did not reach the trigger (covered?)`.

### loop

1. The page scrolls so the section's top is at the top of the viewport, then 300 ms of real time pass. Loops that pause out of view are running.
2. The fake clock runs the warm-up: 3 s, rounded up to a whole number of `periodMs`, or of `durationMs` when the entry has no `periodMs`. Finite animations finish; infinite ones keep running.
3. The trace waits for images in the viewport, then 300 ms.
4. Sampling starts. At sample 0, every infinite CSS or Web Animation first catches up with the fake time that has run since the page loaded.

The catch-up matters because the two drivers keep time differently. A JavaScript loop ran on the fake clock during the warm-up. A CSS loop sat on the frozen timeline and only moves when the trace seeks it. The catch-up puts the CSS loop where it would be had it run since load, so a marquee started at load is at the same point of its cycle on both sides, whatever drives it.

### scrub

1. At the top of the page, the fake clock runs 3 s and the page settles.
2. The trace picks `steps` scroll positions (default 12), evenly spaced from where the section's top meets the bottom of the viewport to where its bottom meets the top. Positions are clamped to what the page can scroll.
3. At each position: scroll there, wait 100 ms of real time, run the fake clock 1 s so smoothed scroll effects catch up, finish every finite animation, then sample.

### The time step

For every kind except `scrub`, each sample repeats three steps:

1. Every running CSS and Web Animation is seeked to its own elapsed time: its time when the trace first saw it, plus 50 ms for each sample since, times its playback rate. Infinite animations hold still unless the kind is `loop`. Paused animations are left alone, because a script sets their time (scroll-linked effects built on Motion's animation controls do this).
2. Every keyed element in the section is recorded.
3. The fake clock runs 50 ms, which fires timers and animation frames, and the trace waits 20 ms of real time so the page draws a frame.

Sample k is therefore k × 50 ms after the trigger. The fake clock fires animation frames every 16 ms, so a JavaScript animation shows the state of its last frame before each sample, while the trace seeks CSS animations to the exact time.

## What a sample records

Each keyed element gets one sample per step: `[x, y, w, h, opacity]`, or `null` when it has no box.

- Keys are the static capture's keys: `t:` plus the lowercased text for text blocks, links, buttons, labels and summaries; `m:img`, `m:svg`, `m:video`, `m:canvas`, `m:iframe` or `m:bg` for media; `root` for the section root.
- The box is the bounding box after transforms, cut to the part that ancestor overflow clips leave visible. A translate moves x and y, a scale changes w and h, and a rotation grows the box.
- Coordinates are relative to the section's top-left corner at the first sample that finds the section, so a section that sits lower on one side does not shift its whole trace.
- Opacity is the element's opacity times every ancestor's, and 0 under `visibility: hidden`.
- `null` means the element is not rendered, not in the page yet, or fully clipped. Content that slides out of an `overflow: hidden` box shows up as a box that shrinks and then disappears. An element added during the trace has `null` samples before it appears.

Normal traces keep the elements that move, at most 150 in document order. Reduced-motion traces keep every keyed element, at most 300, so the grader can check end states.

Each trace is stored in capture.json under `widths.<width>.motion[]` with `stepMs`, `samples`, `scrollY` and `elements: [{ key, kind, tag, track }]`.

## How grading works

grade.mjs compares each original motion entry with the clone entry of the same id and width. The exact rules are in `scripts.md`. In short:

1. Moving elements are paired by key, nearest box first, using each element's last box.
2. A moving element with no partner fails the entry (`unpaired`).
3. At every sample, both sides `null` passes and one side `null` fails (`nullMismatch`). Otherwise x, y, w and h must each be within 2 px and opacity within 0.05 (`maxPx`, `maxOpacity`, `worst`).
4. `load`, `scroll`, `hover` and `click` also compare when motion starts and ends (`startDeltaMs`, `endDeltaMs`). Start is the first sample where any element differs from its sample 0. End is the last sample where anything changes.
5. `loop` entries try time shifts of up to half the trace either way, in quarter-sample steps, and keep the best (`shiftMs`). Positive `shiftMs` means the clone shows each frame later than the original. A loop has no start, so any shift is fine once the shapes match.
6. In loops, a jump that both sides make within 1.5 samples of each other is excused, and so is a jump within 1.5 samples of either end of the compared samples (`excused` counts the samples left out). A jump is a change of at least 4 px or 0.2 opacity between two samples that is also at least 4 times the change on either side, such as a marquee item that wraps back to its start, or a box that appears or disappears. A track with more jumps than the larger of 2 and one per 5 samples gets no excuses.
7. Elements whose key moves in a section's loop entry, in either capture, are left out of that section's other motion entries and their reduced checks. A marquee that keeps running during a reveal is then graded once, by its own entry.

`scrub` entries use rule 3 at each scroll position, with no timing check and no shift.

## Reading a failure

Each result in a section's `motion` list of grade.json carries the fields below. To see a track, open the entry with the same id and width in both capture.json files and read `track[k]` for the element's key. Sample k is k × `stepMs` ms into the trace.

| Field | Meaning | Usual cause |
| --- | --- | --- |
| `missing: true` | The clone trace could not run. The reason is in the clone capture's `notes`. | No `data-pp-section` or `data-pp-trigger`, or an overlay covers the trigger |
| `unpaired` above 0 | A moving element on one side has no moving partner with the same key | The clone moves another element, keeps one still, or its text differs |
| `nullMismatch: true` | At some sample one side has a box and the other has none | An element mounts, unmounts or leaves its clip at another time |
| `maxPx` above 2 | Largest box gap. `worst` names the key and sample | Distance, easing, duration or a static layout difference |
| `maxOpacity` above 0.05 | Largest opacity gap | Opacity values or easing |
| `startDeltaMs` above 50 | Motion starts at another time | Delay, or a reveal that fires at another scroll position |
| `endDeltaMs` above 50 | Motion ends at another time | Duration, or the delay of the last element in a stagger |

The shape of the gap over time points at the cause:

- **The same gap at every sample, the last one included:** a layout difference. The section's static checks usually fail too. Fix those first.
- **No gap at the start and the end, a gap in between:** same distance and duration, different easing. Copy the original's timing function.
- **A gap that grows and then closes:** different duration.
- **The same curve, later or earlier:** different delay. `startDeltaMs` says by how much.
- **A loop that fails at its best shift:** the clone moves at another speed, has another period or follows another path. A loop that passes with a large `shiftMs` is fine.

Reduced checks list failures as `failed: [{ key, reason }]`. `moved` means the clone glides under reduced motion. `end-state` means its last sample differs from the original's last sample. `missing` means the element is not in the reduced trace. `missing-trace` means the reduced trace could not run.

## Building motion on the first pass

1. **Read the original's motion before writing any.** `source/<id>/styles.css` holds the section's transitions, animations and the `@keyframes` they use, and `meta.json` lists its animations. Motion run by JavaScript has no source, because extract drops scripts. Read it from the trace instead: `node "$PP/keyframes.mjs" --capture .pixel-perfect/original --motion <id> --out .pixel-perfect/keyframes/<kind>-<name>.json` (for `scroll:features`, `scroll-features.json`) turns a trace into delays, durations and offsets. Write the clone's motion by hand from those numbers. Shipping the generated file is the [fallback](#the-motion-trace-fallback).
2. **Use the original's driver.** Use CSS when the original's motion is in its CSS, and JavaScript when it is not. Loop entries name it in `driver`. JavaScript animations sample up to 16 to 32 ms behind CSS ones (see [The time step](#the-time-step)). That costs a fraction of a pixel on slow motion and more than 2 px on fast motion.
3. **Use clocks the trace controls.** CSS transitions and animations, Web Animations on the default document timeline, `requestAnimationFrame`, timers, `performance.now()` and `Date.now()` all follow it, and so do the Motion library and GSAP. Avoid timing that the fake clock cannot see, such as timers in a Web Worker.
4. **Start motion on the same trigger.**
   - `load`: start entrances when the page loads, as the original does. Do not wait for something the original does not wait for.
   - `scroll`: the trace jumps to put the section's top at 75% of the viewport height. The clone's reveal must fire at that position exactly when the original's does. Copy the original's observer threshold or scroll offset when you can find it.
   - `hover` and `click`: put the effect on the element marked `data-pp-trigger`, with the same properties, duration, delay and easing.
   - `loop`: start the loop at load and let it run from its first frame. Use the same direction, speed in px per second, and gap between repeated items. When the entry has `periodMs`, one cycle of the clone must last `periodMs`.
5. **Move the layout the way the original does.** When the original animates height, as most accordions do, the content below it moves and is traced. A transform does not move siblings, so a transform-only clone fails there.
6. **Build reduced motion from the start.** See the next section.

## Reduced motion

The clone always respects `prefers-reduced-motion: reduce`, even when the original ignores it. `capture.mjs --mode clone --reduced-motion` traces the clone with the setting on into `clone-reduced/`, and `grade.mjs --reduced .pixel-perfect/clone-reduced` checks each original entry:

- **No gliding.** Each element may jump once, instantly, from where it starts to where it ends. Opacity may change freely, so a fade is allowed. An element that slides fails with `moved`.
- **Same end state.** For `load`, `scroll`, `hover` and `click`, the clone's last sample must be within 2 px and 0.05 opacity of the original's last sample with motion on.
- **Loops get the glide check only,** because a stopped loop has no end state. Under reduced motion a loop stands still or jumps.
- **Scrub entries are not checked.** Sticky and scroll-linked layout moves with the scroll even with no animation.

Ways to get there:

- CSS: put transitions and animations inside `@media (prefers-reduced-motion: no-preference)`. With reduce, elements jump straight to the state their classes give them.
- Motion library: wrap the app in `<MotionConfig reducedMotion="user">`. It turns off transform and layout animations and keeps opacity fades. For loops, read `useReducedMotion()` and do not start them.
- Plain JavaScript: check `matchMedia('(prefers-reduced-motion: reduce)').matches` before starting an animation, and set the end state when it is true.
- Reveals may show their content from the start or jump to it when they fire. Both pass.

## The motion-trace fallback

When a section still fails motion after `GATE.maxFixRounds` (3) rounds, or its score stops improving, grade.json gives it `next: "fallback"` with `motion-trace` in `fallbacks`. For each failing motion entry of that section:

1. **CSS motion:** copy the original's transitions, animations and `@keyframes` from `source/<id>/styles.css` as they are.
2. **JavaScript motion:** generate keyframes from the original's trace and play them with the Motion library.

   ```
   node "$PP/keyframes.mjs" --capture .pixel-perfect/original --motion scroll:features --out src/motion/scroll-features.ts
   ```

   Run it again with `--width 390` when the motion differs on mobile, and pick the file with a media query.
3. **Mark the section:** add `motion-trace` to `data-pp-fallback` on its root. The report flags the section as generated.
4. Run the next round with `round.mjs`.

Generated values are offsets from each element's final box, measured at the box center: `x` and `y` in px, `scaleX` and `scaleY` as ratios, and `opacity`. The easing is already in the samples, so play them linearly:

```ts
import { animate } from 'motion';
import trace from './motion/scroll-features';

// find(key) returns the clone element for a trace key, such as the heading whose text is "Fast setup".
export function playTrace(find: (key: string) => Element | null) {
  for (const { key, delay = 0, duration, periodMs, repeat, times, ...values } of trace.elements) {
    const el = find(key);
    if (!el || duration === undefined) continue;
    animate(el, values, { delay, duration, times, ease: 'linear', repeat });
  }
}
```

- **Keys:** a `t:` key is the element's text, lowercased with whitespace collapsed and cut to 80 characters. Repeated keys, such as several `m:img`, come in document order.
- **Triggers:** start the call where the original starts the motion: on load, when the reveal fires, or on the trigger's hover or click.
- **Nested elements:** a box on the page includes its ancestors' motion. When an element and its ancestor carry the same values (a card slides and its text slides with it), animate the ancestor only, or the motion applies twice.
- **Existing transforms:** Motion sets the element's `transform`. When the element already uses a transform for layout, animate a wrapper instead.
- **Loops:** an element with a numeric `periodMs` covers one cycle and repeats; its values are offsets from the box at the end of the cycle. `periodMs: null` means the trace never showed a full cycle. Do not play that one as is: build the loop from the original's markup and the speed the trace shows.
- **Scrub:** there is no `delay` or `duration`. `times` run over scroll progress from `scrollY[0]` to `scrollY[1]`. Motion's `scroll(animation, { target: section, offset: ['start end', 'end start'] })` covers the same range, unless the section sits so near the top or bottom of the page that the trace clamped it. Then map progress from `scrollY` yourself.
- **Skipped elements:** elements with a sample that has no box are listed in `skipped` and left out. Build them by hand.

## Known limits

- **Long loops.** A loop whose period is longer than about 0.8 of its trace shows no full cycle, so the shift search compares two pieces of one long cycle. That passes only when both sides start the loop at load from the same first frame. Auto plans make CSS loop traces 1.5 times the longest iteration, so their periods are always found. For a long JavaScript loop, raise the entry's `durationMs` in the plan and capture the original again.
- **Repeated marquee items.** Items with the same key are paired by their last box. When the two sides are more than about a quarter period apart, pairs can mix up. Start the clone's marquee at load from the original's first frame.
- **Window edges.** Loop jumps within 1.5 samples (75 ms) of either end of the compared samples are excused even when the other side does not make them.
- **Small loops.** A loop that moves 1.5 px or less gets no period, so keyframes.mjs writes it with `periodMs: null`. Grading is not affected.
- **Shared keys.** When a loop moves an element with some key, every element with that key in the section's other entries is left out. A reveal image with the same `m:img` key as a marquee logo is then not graded. Read its tracks to check it.
- **Clipped marquee items.** Items that leave the clip have `null` samples, so keyframes.mjs skips them and finds no period. Build the marquee from markup at the measured speed.
- **Mixed drivers.** A CSS loop against a JavaScript loop can differ by 14 to 16 ms of frame timing. Above about 120 px per second that can pass 2 px. Use the plan's `driver`.
- **Real-time events.** Scroll events and IntersectionObserver callbacks run in real time, not on the fake clock. The trace waits 300 ms of real time for them before sample 0.
- **Many movers.** Each trace keeps at most 150 moving elements, with a note when more moved.
