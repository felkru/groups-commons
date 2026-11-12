# How the intro video was made

`public/assets/intro.mp4` is a time-compressed replay of a real Claude Code session, not an animation.

1. `record_session.py <project dir> <cast.json> "<prompt>"` runs `claude` in a pseudo-terminal inside a demo project
   (a `CLAUDE.md` memory file for the fictional group "AI Safety Nordhaven" and an `mcp.json` pointing at the commons)
   and records the terminal output with timestamps.
2. `capture_material.mjs <link> <out.png> [page]` opens a link that Claude produced and saves the customized printable.
3. `video.html` + `render.mjs <config.json> <cast.json> <frames dir>` replay the recording in xterm.js (copy `xterm.js` and
   `xterm.css` from the `@xterm/xterm` package next to `video.html`), add captions and the result scenes, and write frames.
4. `ffmpeg -framerate 24 -i frames/f%05d.jpg -c:v libx264 -crf 24 -pix_fmt yuv420p -movflags +faststart intro.mp4`

The to-do list and the message texts in `config.json` are shortened from the files Claude wrote in that session
(`marketing/todo.md`, `email.md`, `chat-groups.md`, `instagram.md`). The captured images of the printables show the
example group's photos and stay out of this repository; capture them again with step 2.
