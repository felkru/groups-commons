# Template contract v1 (customizable HTML printables)

A template is ONE self-contained `.html` file. The site's editor loads it in an iframe, applies the
organizer's brand kit (color, fonts, logos, group name), lets them edit text in place and prints it to PDF.
A template that follows this contract re-brands itself automatically.

## Rules
1. **Self-contained.** No `<script>`. No external resources except Google Fonts stylesheets (`<link>`).
   Images are inline SVG, `data:` URIs, or files next to the template referenced by relative path
   (max 400 KB each; photos go in `photos/`, see 4b).
2. **Brand variables.** Declare these on `:root` with the defaults below, and derive every colour in the design
   from them (plus white/black). Use `color-mix(in srgb, var(--brand-color) 15%, white)` for tints.
   ```css
   :root {
     --brand-color: #8391f6;        /* the brand's accent colour (links, buttons, emphasis) */
     --brand-accent: #481b5d;       /* second, darker accent */
     --brand-dark: #252627;         /* dark surfaces and body text */
     --brand-light: #fefee0;        /* light surfaces */
     --brand-on-color: #ffffff;     /* text colour on --brand-color surfaces (editor computes for contrast) */
     --brand-on-accent: #ffffff;    /* text colour on --brand-accent surfaces */
     --brand-font-heading: 'Hanken Grotesk', system-ui, sans-serif;  /* titles (here: the example group's main font) */
     --brand-font-body: 'Vollkorn', Georgia, serif;                  /* running text */
   }
   ```
   Load the default fonts with
   `<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;600;700;800&family=Vollkorn:wght@400;600;700&display=swap" rel="stylesheet">`.
   The editor overrides the variables as inline styles on `<html>` and loads the chosen fonts itself.
   `--brand-font-heading` is for titles and `--brand-font-body` for running text. A template sets both to the fonts
   of its original, whatever the group's usual pairing is, so the first view matches the print. The editor replaces
   them with a group's brand kit, except for the example group's own untouched kit.
3. **Brand text.** Put `data-brand="<key>"` on any element whose whole text is a brand value; the default text is
   the AI Safety Aachen value. Keys: `group_name`, `tagline`, `university`, `city`, `website`, `email`,
   `join_url`, `instagram`.
   Example: `<span data-brand="group_name">AI Safety Aachen</span>`.
4. **Logos.** `<img data-logo="square" src="logo-square.svg" alt="">` and `<img data-logo="wide" src="logo-wide.svg" alt="">`.
   Ship default logo files next to the template. Size them with CSS (`height` + `width:auto`, `object-fit: contain`)
   so any replacement logo fits. Use `data-logo-on="dark"` when the logo sits on a dark or brand-coloured surface
   (the editor then picks the light logo variant if the organizer provided one).
4b. **Photos.** Real photos carry most of a design, so keep them. Put each photo in a slot:
   `<img data-photo="unique_key" src="photos/members-at-laptop.jpg" alt="Two members working at a laptop">`.
   Photo files are JPEGs in a `photos/` folder next to the template: at most 1600 px on the long edge and 400 KB each,
   metadata removed. Size the slot with CSS (fixed box, `object-fit: cover`, an `object-position` that keeps faces in
   frame), so that a replacement photo of another shape still fits. Give the slot's container a neutral or
   brand-tinted background, so that a missing photo still looks intended. The editor lets the organizer click a photo
   to replace it with their own. Say in the material's description whose photos the defaults are and that other
   groups should replace them. Keys are unique within the file.
5. **QR codes.** `<img data-qr="join_url" alt="QR code" src="...placeholder...">` (or `data-qr="website"`).
   The editor replaces `src` with a generated QR code for that brand value. Use this placeholder as default `src`:
   `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='white'/%3E%3Cpath d='M8 8h28v28H8zM64 8h28v28H64zM8 64h28v28H8z' fill='none' stroke='%23252627' stroke-width='8'/%3E%3Ctext x='50' y='56' font-family='sans-serif' font-size='12' text-anchor='middle' fill='%23252627'%3EQR%3C/text%3E%3C/svg%3E`
   Never embed a real QR code.
6. **Editable text.** Put `data-edit="unique_key"` on every text element an organizer would change (headlines,
   paragraphs, dates, list items, table cells). Keys are unique within the file. The editor makes these
   `contenteditable` and remembers the edits. Don't nest `data-edit` elements.
7. **Pages.** Every printed page is `<section class="page">` with exact physical size, e.g.
   `width: 210mm; height: 297mm; overflow: hidden; break-after: page;`. Add
   `@page { size: 210mm 297mm; margin: 0 }` and
   `* { -webkit-print-color-adjust: exact; print-color-adjust: exact }`.
   On screen, `body { margin: 0; background: #e9e9ee }` and pages are centred with a 24px gap; in
   `@media print` remove gaps, shadows and the body background.
   Declare the size for the previewer: `<meta name="commons:page" content="210mm 297mm">` (width height of one
   page) and a human label `<meta name="commons:format" content="A4 portrait">`.
   Slides use `338.67mm 190.5mm` (16:9); Instagram posts `1080px 1350px` or `1080px 1080px`.
8. **Robust layout.** Text must not overflow when the group name is 30 characters long or fonts change
   (use flex/grid, `overflow-wrap: anywhere`, no absolute pixel positioning of text over text). It must look
   good with any brand colour, including a dark red or a bright green.
9. **Restraint.** Take the look from the group's real materials, not from the palette. Large surfaces are neutral
   (white, `--brand-light`, `--brand-dark`) or photos. `--brand-color` and `--brand-accent` are accents: a few words
   of a headline, a rule, a button, one panel if the original has one. Do not add ornaments (rings, dots, gradients,
   blobs) that the original design does not have. When in doubt, use less colour and more photo.
10. **No private data** (see `SEED_FORMAT.md`): no real people's names, no private links, no real QR codes.

## Minimal skeleton
```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Table sign</title>
<meta name="commons:page" content="210mm 297mm"><meta name="commons:format" content="A4 portrait">
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;600;700;800&family=Vollkorn:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--brand-color:#8391f6;--brand-accent:#c76d7e;--brand-dark:#252627;--brand-light:#fefee0;--brand-on-color:#fff;--brand-on-accent:#fff;--brand-font-heading:'Vollkorn',Georgia,serif;--brand-font-body:'Hanken Grotesk',system-ui,sans-serif}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#e9e9ee;font-family:var(--brand-font-body);color:var(--brand-dark)}
.page{width:210mm;height:297mm;margin:24px auto;background:var(--brand-light);overflow:hidden;break-after:page;display:flex;flex-direction:column;padding:18mm}
h1{font-family:var(--brand-font-heading);font-size:22mm;line-height:1.02;margin:0}
@page{size:210mm 297mm;margin:0}
@media print{body{background:none}.page{margin:0}}
</style></head><body>
<section class="page">
  <img data-logo="wide" src="logo-wide.svg" alt="" style="height:16mm;width:auto;align-self:flex-start">
  <h1 data-edit="headline">Curious about AI safety?</h1>
  <p data-edit="lead">Join <span data-brand="group_name">AI Safety Aachen</span> ...</p>
  <img data-qr="join_url" alt="QR code" src="data:image/svg+xml,..." style="width:50mm;height:50mm">
</section>
</body></html>
```
