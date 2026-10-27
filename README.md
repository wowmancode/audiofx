# AudioFX

A real-time audio effects app that runs entirely in the browser, including on Android. It has 37 effects you stack into your own chain, live microphone or audio-file input, and a vocoder with an on-screen keyboard. GitHub Actions tests it and publishes it to GitHub Pages.

There are no character presets. Every effect is a plain building block with its own controls, and the chain starts empty.

## Use it

1. Push to `main`. The workflow in `.github/workflows/pages.yml` tests and deploys.
2. One-time setup: **Settings > Pages > Build and deployment > Source: GitHub Actions**.
3. Open `https://wowmancode.github.io/audiofx/` (on Android, in Chrome).
4. Tap **Use microphone** (or **Play audio file**), then **Add effect** and build your chain.

Use wired headphones with the microphone, otherwise the speaker feeds back into the mic. Your chain and settings are remembered on the device.

## Effects

| Group | Effects |
| --- | --- |
| Dynamics | Gain, Compressor, Limiter, Noise gate |
| Distortion | Saturation, Hard clip, Wavefolder, Bitcrusher |
| Filter & EQ | Low-pass, High-pass, Band-pass, Notch, Equalizer, Auto-wah, Filter sweep (LFO), Formant filter |
| Modulation | Tremolo, Chorus, Flanger, Phaser, Vibrato, Tape wobble |
| Delay & reverb | Delay, Ping-pong delay, Reverb, Comb resonator, Stutter |
| Pitch & frequency | Pitch shifter, Harmonizer, Reverse, Frequency shifter, Ring modulator |
| Stereo & texture | Stereo width, Auto-pan, Pan, Noise & crackle |
| Voice | Vocoder |

Order matters: effects run top to bottom, and you can reorder, bypass, collapse and reset each one. Double-tap a control's name to reset it.

### The vocoder

A filter-bank vocoder: your voice (the modulator) shapes a built-in synth (the carrier). Controls cover band count and range, band sharpness, envelope attack and release, formant shift, carrier pitch, detune, saw/pulse/noise mix, an optional second voice at an interval, and carrier drive. For intelligibility it adds high-frequency emphasis and a sibilance path that only opens on S, T and F sounds. Hold keys on the on-screen keyboard to choose notes; with none held, the Carrier pitch slider plays.

## How it works

```
web/
  index.html, style.css, app.js   UI, input handling, recording, saved state
  worklet.js                      AudioWorklet that runs the chain on the audio thread
  dsp/                            all effects, plain JavaScript with no browser APIs
    core.js                       filters, delay line, base class, registry
    dynamics.js filters.js modulation.js time.js pitch.js spatial.js vocoder.js
test/
  test.mjs                        renders every effect offline (see below)
  worklet.test.mjs                checks the worklet message protocol
```

Because the DSP is plain JavaScript, the same code runs in the browser's audio thread and in Node, which is what lets CI test it. To add an effect, write a class in `web/dsp/` with `static params` and a `process(L, R, n)` method, then `register()` it. The UI builds its controls from the parameter list.

## Develop

```
npm test        # offline checks, needs Node 18+
npm start       # serves web/ locally
```

Microphone access needs HTTPS or `localhost`.

`npm test` renders all 37 effects at 44.1 and 48 kHz and checks that output is finite, audible and bounded; fuzzes 25 random and extreme parameter sets per effect while changing them mid-stream; verifies every effect uses well under a quarter of real time; and runs a series chain of everything.

## Notes

- Latency depends on the device. Android Chrome typically gives roughly 20 to 100 ms with wired headphones.
- Distortion effects are not oversampled, so very high drive can alias.
- Recording saves WebM/Opus (or whatever the browser supports) from the processed output.
