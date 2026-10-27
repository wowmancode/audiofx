# AudioFX

An Android app for real-time audio effects. It has 37 effects you stack into your own chain, live microphone or audio-file input, output recording, and a vocoder with an on-screen keyboard. GitHub Actions builds the APK for you.

There are no character presets. Every effect is a plain building block with its own controls, and the chain starts empty.

## Get the APK

1. Push to `main` (or run the **Build APK** workflow by hand from the Actions tab).
2. When it finishes, open the repo's **Releases** page. The newest release has `AudioFX.apk`.
3. On your phone, download it and open it. Android asks once to allow installs from your browser.

The latest build is always at `https://github.com/wowmancode/audiofx/releases/latest/download/AudioFX.apk`. The same file is also attached to each workflow run as the `AudioFX-apk` artifact.

Each build has a higher version number and the same signing key, so a new APK installs over the old one without uninstalling. The signing key is a personal sideload key kept in `android/audiofx.keystore`; replace it if you ever publish to an app store.

The app works fully offline and asks only for the microphone permission. Use wired headphones with the microphone, otherwise the speaker feeds back into the mic. Your chain and settings are remembered on the device, and recordings are saved to `Downloads/AudioFX`.

## Effects

| Group | Effects |
| --- | --- |
| Dynamics | Gain, Compressor, Limiter, Noise gate |
| Distortion | Saturation, Hard clip, Wavefolder, Bitcrusher |
| Filter & EQ | Low-pass, High-pass, Band-pass, Notch, Equalizer, Auto-wah, Filter sweep (LFO), Formant filter |
| Modulation | Tremolo, Chorus, Flanger, Phaser, Vibrato, Tape wobble |
| Delay & reverb | Delay, Ping-pong delay, Reverb, Comb resonator, Stutter |
| Pitch & frequency | Pitch shifter, Harmonizer, Reverse, Frequency shifter, Ring modulator |
| Stereo & texture | Stereo widener, Auto-pan, Noise & crackle |
| Code | Custom code: write your own effect in JavaScript |
| Voice | Vocoder |

Order matters: effects run top to bottom, and you can reorder, bypass and collapse each one.

**Auto level** (on by default) rides the input to a steady level so a quiet phone microphone and a loud file make every effect react the same way. Turn it off in the Input panel for full manual control.

**Custom code** runs your JavaScript for every audio sample, with four sliders (name them with `// knob1: Label` comments), delay, filter, envelope and oscillator helpers, and a list of examples. The app tests your code in a background worker first, so an error or an endless loop is reported and never reaches the audio.

### The vocoder

A filter-bank vocoder: your voice (the modulator) shapes a built-in synth (the carrier). Controls cover band count and range, band sharpness, envelope attack and release, formant shift, carrier pitch, detune, saw/pulse/noise mix, an optional second voice at an interval, and carrier drive. For intelligibility it adds high-frequency emphasis and a sibilance path that only opens on S, T and F sounds. Hold keys on the on-screen keyboard to choose notes; with none held, the Carrier pitch slider plays.

## How it works

```
android/                          small WebView app that bundles web/ into an APK
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
npm start       # serves web/ in a desktop browser for quick UI work
```

The Android app serves `web/` from inside the APK over a virtual https origin, which gives the page the secure context the microphone and AudioWorklet need. To build the APK locally you need JDK 17, the Android SDK and Gradle 8.9: `gradle -p android assembleRelease`.

`npm test` renders all 37 effects at 44.1 and 48 kHz and checks that output is finite, audible and bounded; fuzzes 25 random and extreme parameter sets per effect while changing them mid-stream; verifies every effect uses well under a quarter of real time; and runs a series chain of everything. CI runs these before building the APK, then checks the APK is signed and contains the web files.

## Notes

- Latency depends on the device. Expect roughly 20 to 100 ms with wired headphones. The app runs in Android System WebView, so keep that updated.
- Distortion effects are not oversampled, so very high drive can alias.
- Recording saves WebM/Opus (or whatever the WebView supports) from the processed output.
