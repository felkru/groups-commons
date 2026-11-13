"""The soundtrack of the intro video: a generated music clip, cut to the picture bar by bar, plus accents that are
placed by code on what happens on screen.

Usage: uv run --no-project --with numpy --with scipy python music.py <config.json> <clip.wav> <out.wav>

The clip comes from Google's Lyria model (prompt in music-prompt.json, seed 101); it is not in the repository. It
plays at exactly 120 beats a minute, its beats lie 50 ms before every half second, and it has this shape:
bars 0-4 groove, bar 5 a quiet breakdown, bars 6-7 a build, bars 8-15 the fuller groove.

The video runs on the same grid (config: music.bpm, music.first_bar), so the clip's bars can be laid under it:

  video   picture                         music
  0.5     title                           the groove from far away (thin, no bass)
  2.5     the sentence is typed           the same, opening slowly
  6.5     "knows the group"               the beat arrives; a soft bell marks every new caption
 10.5     "searches the commons"          the bass arrives, the sound keeps opening
 16.5     (same caption)                  the clip's own breakdown
 18.5     "seven minutes later"           the clip's own build, with a riser and a roll on top
 22.5     the to-do list                  the fuller groove; one bell per line of the list as it slides in
 30.5     the printables                  an accent as each printable lands (one per second)
 38.5     the texts                       a soft blip per message card
 46.5     "Human copy. Human taste."      the breakdown again, quiet and distant
 52.5     "Use it through Claude."        the groove comes back for one bar
 54.5                                     one last hit that rings out to the end
"""
import json
import os
import sys
import wave

import numpy as np
from scipy import signal

if len(sys.argv) != 4 or os.path.abspath(sys.argv[2]) == os.path.abspath(sys.argv[3]):
    sys.exit('Usage: music.py <config.json> <clip.wav> <out.wav>   (the output must not be the clip)')
cfg = json.load(open(sys.argv[1]))
with wave.open(sys.argv[2]) as w:
    SR = w.getframerate()
    clip = np.frombuffer(w.readframes(w.getnframes()), '<i2').reshape(-1, w.getnchannels()).T / 32768.0
DUR = float(cfg['duration'])
BEAT = 60.0 / cfg['music']['bpm']
BAR = 4 * BEAT
BAR0 = cfg['music']['first_bar']
CLIP_FIRST_BEAT = cfg['music'].get('clip_first_beat', -0.050)  # where bar 0 of the clip starts, in the clip's time
KEY = cfg['music'].get('scale', [65, 68, 70, 72, 75])          # F minor pentatonic: safe over every chord of the clip
N = int(DUR * SR)
rng = np.random.default_rng(7)
bar = lambda k: BAR0 + k * BAR
hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)
S = cfg['scenes']
ST = cfg.get('stagger', {})


def butter(x, kind, freq, order=2):
    return signal.sosfilt(signal.butter(order, freq, kind, fs=SR, output='sos'), x)


def tt(seconds):
    return np.arange(int(seconds * SR)) / SR


def fade(x, a=0.004, r=0.02):
    n_a, n_r = max(1, int(a * SR)), max(1, int(r * SR))
    x = x.copy()
    x[..., :n_a] *= np.linspace(0, 1, n_a)
    x[..., -n_r:] *= np.linspace(1, 0, n_r)
    return x


def put(b, t, x, gain=1.0, pan=0.0):
    """Adds a sound at time t. x is mono (then pan applies, -1 left to 1 right) or stereo."""
    i = int(round(t * SR))
    if i >= N:
        return
    if i < 0:
        x = x[..., -i:]
        i = 0
    x = x[..., : N - i]
    n = x.shape[-1]
    if x.ndim == 1:
        b[0, i:i + n] += x * gain * np.sqrt((1 - pan) / 2) * 1.414
        b[1, i:i + n] += x * gain * np.sqrt((1 + pan) / 2) * 1.414
    else:
        b[:, i:i + n] += x * gain


# ---------------------------------------------------------------- the clip, bar by bar
PRE = 0.012  # every bar is taken a little early (to keep the kick's attack) and cross-fades with the one before


def clip_bar(b):
    a = CLIP_FIRST_BEAT + b * BAR - PRE
    i, j = int(round(a * SR)), int(round((a + PRE + BAR) * SR))
    seg = np.zeros((2, j - i))
    lo = max(i, 0)
    seg[:, lo - i:] = clip[:, lo:j][:, : j - lo]
    if i < 0:
        # The clip begins 50 ms into its first kick. The same beat four bars later is whole: borrow its attack.
        k = int(round((CLIP_FIRST_BEAT + (b + 4) * BAR - PRE) * SR))
        n = int(0.11 * SR)
        mixin = np.linspace(1, 0, n) ** 2
        seg[:, :n] = clip[:, k:k + n] * mixin + seg[:, :n] * (1 - mixin)
    return fade(seg, PRE, PRE)  # fades out exactly while the next bar fades in


# video bar -> clip bar
DROP, BREAK, END, HIT = 11, 23, 26, 27
PLAN = {0: 2, 1: 3, 2: 4,                      # far away: the end of the first phrase
        3: 0, 4: 1, 5: 2, 6: 3, 7: 4,          # the groove
        8: 5, 9: 6, 10: 7,                     # the clip's breakdown and build
        **{DROP + i: 8 + i for i in range(8)},        # to-do list and printables: the fuller groove
        **{DROP + 8 + i: 8 + i for i in range(4)},    # the texts: its first half again
        23: 5, 24: 5, 25: 6,                   # the claim: the breakdown, twice, then the build
        26: 8}                                 # the last scene: one bar of the fuller groove


def lay(bars):
    out = np.zeros((2, N))
    for k in bars:
        put(out, bar(k) - PRE, clip_bar(PLAN[k]))
    return out


def automate(x, kind, points, shape=1.0):
    """Filters x with a cutoff that moves through points [(time, Hz), ...]; before and after them x is untouched."""
    times = [p[0] for p in points]
    logf = np.log([p[1] for p in points])
    i, j = int(times[0] * SR), min(int(times[-1] * SR), x.shape[1])
    step = 256
    zi = np.zeros((2, 1, 2))
    for s in range(i, j, step):
        fc = float(np.exp(np.interp(s / SR, times, logf)))
        sos = signal.butter(2, min(fc, SR / 2 - 500), kind, fs=SR, output='sos')
        for c in range(2):
            x[c, s:s + step], zi[c] = signal.sosfilt(sos, x[c, s:s + step], zi=zi[c])


t_typed, t_knows, t_search, t_fits, t_later = [c[0] + 0.1 for c in cfg['term_captions']]  # captions change on bar lines
t_drop, t_break, t_end, t_hit = bar(DROP), bar(BREAK), bar(END), bar(HIT)

# The build is laid out and filtered by itself, so that no filter starts or stops in the middle of a sound.
build = lay(range(0, DROP))
# the title is far away; while the sentence is typed the groove is there without its low end; then the beat arrives
automate(build, 'low', [(0.0, 700), (t_typed, 1800), (t_knows, 9000), (t_search, 20000)])
automate(build, 'high', [(0.0, 300), (t_typed, 220), (t_knows - 0.02, 170), (t_knows, 25), (bar(10), 25), (t_drop - 0.25, 420), (t_drop, 520)])
n_gap = int(0.07 * SR)
build[:, int(t_drop * SR) - n_gap:int(t_drop * SR)] *= np.linspace(1, 0, n_gap)  # a breath before the drop
build[:, int(t_drop * SR):] = 0

main = lay(list(range(DROP, BREAK)) + [END])

# the claim: quiet and distant, opening again in its last bar
claim = lay(range(BREAK, END))
automate(claim, 'low', [(t_break - 0.05, 1700), (bar(25), 1300), (t_end, 9000)])

# the last hit: a downbeat of the fuller groove, left to ring
hit = clip_bar(9)[:, : int(0.75 * SR)]
hit = fade(hit, PRE, 0.35)
put(main, t_hit - PRE, hit)
music = build + main + claim

# level of the clip through the video (in dB): gentle start, full at the drop, quiet claim
t = np.arange(N) / SR
gain_db = np.interp(t, [0, 0.5, t_typed, t_knows - 0.05, t_knows, t_search, bar(8), bar(9), t_drop - 0.05, t_drop, t_break - 0.05, t_break, bar(25), t_end - 0.05, t_end, t_hit],
                    [-60, -2.0, 0.0, 1.0, -2.5, -1.5, -1.5, -1.5, -0.5, 0.0, 0.0, -4.5, -4.0, -2.0, 0.0, 0.0])
music *= 10 ** (gain_db / 20)

# ---------------------------------------------------------------- accents, written for the picture
fx = np.zeros((2, N))      # goes through a reverb
dry = np.zeros((2, N))


def bell(m, length=1.0, decay=4.0):
    tm = tt(length)
    ph = 2 * np.pi * hz(m) * tm
    out = np.sin(ph + 0.8 * np.exp(-tm * 10) * np.sin(2 * ph)) * np.exp(-tm * decay)
    out += 0.25 * np.sin(2 * ph) * np.exp(-tm * decay * 1.8) + 0.08 * np.sin(3.01 * ph) * np.exp(-tm * decay * 3)
    return fade(out, 0.003, 0.05)


def sweep(length, lo=300.0, hi=9000.0, rising=True, shape=2.2):
    n = int(length * SR)
    x = rng.standard_normal(n)
    out = np.zeros(n)
    pos = np.linspace(0, 1, n)
    centres = np.geomspace(lo, hi, 9)
    for i, c in enumerate(centres):
        band = butter(x, 'band', [c * 0.75, min(c * 1.35, SR / 2 - 100)])
        out += band * np.exp(-((pos - i / (len(centres) - 1)) ** 2) / 0.012)
    out *= pos ** shape
    return fade(out if rising else out[::-1], 0.01, 0.01)


def crash(length=2.4):
    tm = tt(length)
    return fade(butter(rng.standard_normal(len(tm)), 'high', 4500) * np.exp(-tm / (length / 4.5)), 0.001, 0.2)


def boom():
    tm = tt(1.3)
    f = 41 + 55 * np.exp(-tm / 0.05)
    return fade(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tm / 0.38), 0.002, 0.2)


def snare():
    tm = tt(0.18)
    return fade(butter(rng.standard_normal(len(tm)), 'high', 1800) * np.exp(-tm / 0.045), 0.001, 0.02)


def tick():
    tm = tt(0.06)
    return fade(butter(rng.standard_normal(len(tm)), 'band', [2500, 9000]) * np.exp(-tm / 0.008), 0.0005, 0.01)


# a soft bell on every new caption under the terminal
for tc, _ in cfg['term_captions'][1:]:
    put(fx, tc + 0.1, bell(KEY[3] + 12, 1.6, 2.6), 0.085)
    put(fx, tc + 0.1 - 0.45, sweep(0.45, 900, 7000), 0.030)
# into the terminal
put(fx, 0.2, sweep(2.3, 250, 5000, shape=1.6), 0.035)
# "seven minutes later": riser and roll into the drop
put(fx, t_later, sweep(t_drop - t_later, 300, 12000, shape=2.8), 0.17)
put(fx, t_drop - 1.2, crash(1.2)[::-1], 0.07)  # a cymbal played backwards, ending on the drop
roll = [t_drop - 2 * BEAT + i * BEAT / 2 for i in range(2)] + [t_drop - BEAT + i * BEAT / 4 for i in range(4)]
for i, tr in enumerate(roll):
    put(dry, tr, snare(), 0.07 + 0.02 * i)
put(fx, t_drop, crash(2.6), 0.085)
put(dry, t_drop, boom(), 0.20)
# one bell per line of the to-do list, climbing, as each line slides in
first, step = ST.get('todo', [0.2, 0.32])
scale = [KEY[i % 5] + 12 * (i // 5) + 12 for i in range(len(cfg['todo']))]
for i, m in enumerate(scale):
    tl = S['todo'][0] + first + i * step
    put(fx, tl, bell(m, 0.7, 6), 0.16, pan=-0.5 + i / 8)
    put(dry, tl, tick(), 0.06, pan=-0.5 + i / 8)
# an accent as each printable lands: a breath in, then a bright two-note chime
first, step = ST.get('results', [0.15, 0.7])
for i in range(len(cfg['items'])):
    ti = S['results'][0] + first + i * step
    put(fx, ti - 0.25, sweep(0.25, 1200, 11000), 0.085, pan=-0.6 + 0.3 * i)
    put(dry, ti, tick(), 0.07, pan=-0.6 + 0.3 * i)
    put(fx, ti, bell(KEY[(2 * i) % 5] + 24, 0.9, 5), 0.14, pan=-0.6 + 0.3 * i)
    put(fx, ti, bell(KEY[(2 * i + 2) % 5] + 24 + (12 if (2 * i) % 5 + 2 >= 5 else 0), 0.9, 5), 0.10, pan=-0.6 + 0.3 * i)
put(fx, bar(DROP + 4) - 1.0, sweep(1.0, 600, 9000), 0.08)
put(fx, bar(DROP + 4), crash(1.6), 0.05)
# a soft two-note blip per message card
first, step = ST.get('cards', [0.1, 0.65])
for i in range(len(cfg['cards'])):
    tc = S['msgs'][0] + first + i * step
    put(fx, tc - 0.2, sweep(0.2, 2000, 9000), 0.05, pan=0.5 - 0.33 * i)
    put(fx, tc, bell(KEY[3] + 24, 0.25, 14), 0.115, pan=0.5 - 0.33 * i)
    put(fx, tc + 0.075, bell(KEY[0] + 36, 0.4, 9), 0.115, pan=0.5 - 0.33 * i)
put(fx, bar(DROP + 8) - 1.0, sweep(1.0, 600, 9000), 0.08)
put(fx, bar(DROP + 8), crash(1.6), 0.05)
# into the claim: everything breathes out
put(fx, t_break, sweep(1.8, 400, 9000, rising=False, shape=1.6), 0.050)
put(fx, t_break, crash(3.0), 0.035)
put(dry, t_break, boom(), 0.10)
# into the last scene: a breath in, the groove returns
put(fx, t_end - 2.0, sweep(2.0, 300, 10000, shape=2.6), 0.13)
put(fx, t_end - 1.0, crash(1.0)[::-1], 0.06)
put(fx, t_end, crash(2.4), 0.075)
put(dry, t_end, boom(), 0.18)
# the last hit, one bar later: it rings out under the button, with a soft open chord (root and fifth of the key)
put(fx, t_hit - 0.5, sweep(0.5, 800, 10000), 0.07)
put(fx, t_hit, crash(3.2), 0.07)
put(dry, t_hit, boom(), 0.15)


def glow(m, length):
    tm = tt(length)
    out = np.zeros_like(tm)
    for det in (-0.004, 0.0, 0.004):
        for n in range(1, 7):
            out += np.sin(2 * np.pi * n * hz(m) * (1 + det) * tm + n * det * 900) / n ** 1.6
    return out * np.minimum(1, tm / 0.03) * np.exp(-tm / (length / 3.2))


ring = DUR - t_hit
for i, m in enumerate([KEY[0] - 24, KEY[3] - 24, KEY[0] - 12, KEY[3] - 12, KEY[0]]):
    put(fx, t_hit, fade(glow(m, ring), 0.01, 0.3), 0.028 if i else 0.036, pan=-0.5 + 0.25 * i)
for i, m in enumerate([KEY[3] + 12, KEY[0] + 24, KEY[3] + 24]):  # three notes that climb away after the hit
    put(fx, t_hit + 0.25 + i * 0.5, bell(m, 2.0, 2.2), 0.09 - 0.012 * i, pan=0.2 - 0.2 * i)


def reverb(b, seconds, level):
    n = int(seconds * SR)
    tm = np.arange(n) / SR
    out = np.zeros_like(b)
    for c in range(2):
        ir = butter(butter(rng.standard_normal(n), 'low', 7000), 'high', 350) * np.exp(-tm / (seconds / 5.5))
        ir[: int(0.010 * SR)] = 0
        out[c] = signal.fftconvolve(b[c], ir)[:N] * level * 0.012
    return out


def echo(b, time, feedback=0.35, taps=4, level=0.3):
    out = np.zeros_like(b)
    d = int(time * SR)
    for i in range(1, taps + 1):
        out[(i + 1) % 2, i * d:] += b[i % 2][: N - i * d] * level * feedback ** (i - 1)
    return out


fx += echo(fx, BEAT * 0.75)
# the claim and the last hit get a room around them
room = music.copy()
room[:, int(t_knows * SR):int(t_break * SR)] = 0
room[:, int(t_end * SR):int(t_hit * SR)] = 0
mix = music + dry + fx + reverb(fx, 2.2, 0.5) + reverb(room, 3.0, 0.7)
for c in range(2):
    mix[c] = butter(mix[c], 'high', 30)
# fade out at the very end
mix *= np.interp(t, [0, DUR - 0.9, DUR - 0.08, DUR], [1, 1, 0, 0])

# Loudness: the full part sits at about -15.5 dBFS on average. The clip's kick drum stands far above the rest, so a
# limiter turns the level down for the few milliseconds around each kick (it looks 20 ms ahead, so nothing clips
# and nothing is distorted).
from scipy.ndimage import minimum_filter1d, uniform_filter1d

i, j = int(t_drop * SR), int(t_break * SR)
mix *= 10 ** (-15.5 / 20) / np.sqrt(np.mean(mix[:, i:j] ** 2))
ceiling = 0.89
peak = np.max(np.abs(mix), axis=0)
need = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
win = int(0.040 * SR)
gain = uniform_filter1d(minimum_filter1d(need, size=win), size=win)
mix *= gain
over = gain < 0.999
print(f'limiter: at work {100 * over.mean():.1f} % of the time, at most {-20 * np.log10(gain.min()):.1f} dB, on average {-20 * np.log10(gain[over].mean() if over.any() else 1):.1f} dB while at work')

with wave.open(sys.argv[3], 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype('<i2').tobytes())
print(f'{sys.argv[3]}: {DUR:.0f} s, peak {20 * np.log10(np.max(np.abs(mix))):.1f} dBFS, rms {20 * np.log10(np.sqrt(np.mean(mix ** 2))):.1f} dBFS, share above the knee {100 * over.mean():.2f} %')
