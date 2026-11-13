# How the intro video was made

`public/assets/intro.mp4` is a time-compressed replay of a real Claude Code session, not an animation.

1. `record_session.py <project dir> <cast.json> "<prompt>"` runs `claude` in a pseudo-terminal inside a demo project
   (a `CLAUDE.md` memory file for the fictional group "AI Safety Nordhaven" and an `mcp.json` pointing at the commons)
   and records the terminal output with timestamps.
2. `capture_material.mjs <link> <out.png> [page]` opens a link that Claude produced and saves the customized printable.
3. `video.html` + `render.mjs <config.json> <cast.json> <frames dir>` replay the recording in xterm.js (copy `xterm.js` and
   `xterm.css` from the `@xterm/xterm` package next to `video.html`), add captions and the result scenes, and write frames.
4. The music: `uv run --no-project --with numpy --with scipy python music.py config.json <clip.wav> music.wav`.
   The clip is 33 seconds of instrumental music from Google's Lyria model on Vertex AI (`lyria-002`, the prompt in
   `music-prompt.json`, seed 101; the same seed gives the same clip). It plays at exactly 120 beats a minute, and the
   video runs on the same grid (`music` in `config.json`: scene changes on bar lines, list entries on the beat), so
   `music.py` lays the clip's bars under the picture and adds the accents: a bell per line of the to-do list, a chime
   as each printable lands, a blip per message card, the riser into the to-do list, the last hit. The table at the top
   of `music.py` says what happens when.
5. `ffmpeg -framerate 24 -i frames/f%05d.jpg -i music.wav -c:v libx264 -crf 24 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart -shortest intro.mp4`

The to-do list and the message texts in `config.json` are shortened from the files Claude wrote in that session
(`marketing/todo.md`, `email.md`, `chat-groups.md`, `instagram.md`). The captured images of the printables show the
example group's photos and stay out of this repository; capture them again with step 2.
