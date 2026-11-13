# Template contract (re-brandable HTML printables)

A template on the Groups Commons (__DEFAULT_URL__) is ONE self-contained `.html` file: a flyer, poster, sign, slide
deck or social media post. The site's editor loads it, applies a group's brand kit (colours, fonts, logos, name),
lets the organizer change texts in place and prints it to PDF. The default look is the design as its original group
made it; another group's kit replaces colours, fonts, logos and the group's details, and everything else stays.
Follow this contract when you write a template by hand, and when you check one that `commons convert` made from a PDF.

## The file
- No `<script>`, no inline event handlers (`onclick=`), no `<form>`, `<iframe>`, `<object>` or `<embed>`. The upload
  is rejected otherwise.
- No external requests except Google Fonts stylesheets (`<link href="https://fonts.googleapis.com/css2?...">`).
  Pictures are inline SVG, `data:` URIs, or files next to the template with a relative path (photos in `photos/`,
  JPEG, at most 1600 px on the long edge and about 400 KB each).
- No private data: no names of private people, phone numbers, personal email addresses, private links, real QR codes.

## Pages
- Every printed page is one `<section class="page">` with its exact size:
  `.page{width:210mm;height:297mm;overflow:hidden;break-after:page}`.
- `@page{size:210mm 297mm;margin:0}` and `*{-webkit-print-color-adjust:exact;print-color-adjust:exact}`. On screen
  `body{margin:0;background:#e9e9ee}` and `.page{margin:24px auto}`; in `@media print` no margins, no body background.
- In `<head>`: `<meta name="commons:page" content="210mm 297mm">` (width and height of one page) and
  `<meta name="commons:format" content="A4 portrait">` (a label for people).
- Keep the size of the original: A6 to A3, `338.67mm 190.5mm` for 16:9 slides, `1080px 1350px` or `1080px 1080px`
  for Instagram posts.

## Colours and fonts: the `--brand-*` variables
Declare all eight on `:root`. The defaults are the ORIGINAL's own colours and fonts, so the default look matches the
print. Take every colour of the design from them (plus white and black); make tints with
`color-mix(in srgb, var(--brand-color) 15%, white)`.

```css
:root{
  --brand-color:#8391f6;      /* main colour: emphasis, rules, buttons, one panel */
  --brand-accent:#c76d7e;     /* second colour */
  --brand-dark:#252627;       /* dark surfaces and body text */
  --brand-light:#fefee0;      /* light surfaces */
  --brand-on-color:#ffffff; --brand-on-accent:#ffffff;   /* text on those two (the editor sets them for contrast) */
  --brand-font-heading:'Hanken Grotesk',system-ui,sans-serif; --brand-font-body:'Vollkorn',Georgia,serif;
}
```

Load the two default fonts from Google Fonts; the editor loads a kit's fonts itself. A dark design builds its dark
surfaces from `--brand-dark`, so that it stays dark under another kit.

## Text
- `data-edit="unique_key"` on every text an organizer would change (headline, paragraph, date, list item, table
  cell). Keys are unique in the file. Do not nest `data-edit` elements.
- `data-brand="key"` on an element whose whole text is a detail of the group; the editor fills it from the kit.
  Keys: `group_name`, `tagline`, `university`, `city`, `website`, `email`, `join_url`, `survey_url`, `instagram`.
  The text in the file is the original group's value: `<span data-brand="group_name">AI Safety Aachen</span>`.
  A kit that leaves the detail empty leaves the place empty. On `<a data-brand="website|email|instagram|...">` the
  link target is set as well.
- `data-brand-own` on wording that only fits the original group (its legal form after the name, a slogan with its
  city). It is hidden under any other kit.
- `data-brand-other="group_name"` on a text that names the original group's event or series (a banner's title).
  Under another kit it shows that group's name instead, unless the organizer typed their own text. It can carry
  `data-edit` too.

## Pictures
- **Photos:** `<img data-photo="unique_slot" src="photos/members.jpg" alt="...">`, or `<image data-photo="...">`
  inside SVG artwork. The organizer clicks a photo to replace it. Give the slot a fixed box (`object-fit:cover`), so
  a picture of another shape fits. Partner and sponsor logos are photo slots too: they are not the group's logo and
  must not change with the kit.
- **The group's logo:** `<img data-logo="wide" src="logo-wide.svg" alt="">` or `data-logo="square"`. The `src` is the
  original group's logo (a file next to the template or a `data:` URI); another kit puts its own logo there. Add
  `data-logo-on="dark"` when the logo sits on a dark or brand-coloured surface (the kit's light variant is used).
  Size it with CSS (`height` plus `width:auto`, `object-fit:contain`). No opacity, no filters. In SVG artwork the
  slot is `<image data-logo="wide|square" href="...">`.
- **`data-logo-box="x,y,width,height"`** on an SVG `<image data-logo>`: the box another group's logo gets, when the
  original mark is placed in a way no other logo would fit (it bleeds off the page, say). The original keeps its own
  `x`, `y`, `width`, `height`.
- **A logo that is not the group's own** (the logo of an event or a series): `<img data-logo="wide"
  data-logo-slot="event">`. The slot has its own name, so a picture the organizer chooses for it does not replace
  the group's logo elsewhere; under another kit it shows that group's logo.
- **`data-logo-for="slot"`** on drawn artwork (a `<g>` of shapes, an emblem) that is the template's own logo. It is
  hidden as soon as the slot named `data-logo-slot="slot"` shows a picture. An empty slot (`<image data-logo="square"
  data-logo-slot="event">` without `href`) next to it is enough.
- **QR codes:** `<img data-qr="join_url" alt="QR code" src="...placeholder...">`; also `data-qr="website"` and
  `data-qr="survey_url"`. The editor draws the code for that detail of the kit. Put it on a white tile. The `src` in
  the file is this placeholder, never a real code:
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='white'/%3E%3Cpath d='M8 8h28v28H8zM64 8h28v28H64zM8 64h28v28H8z' fill='none' stroke='%23252627' stroke-width='8'/%3E%3Ctext x='50' y='56' font-family='sans-serif' font-size='12' text-anchor='middle' fill='%23252627'%3EQR%3C/text%3E%3C/svg%3E`

## Layout that survives another kit
A group name of 30 characters and other fonts must not break the page: flex or grid, `overflow-wrap:anywhere`, no
text placed over other text by pixel. Keep the look of the original: large surfaces are neutral (white,
`--brand-light`, `--brand-dark`) or photos, the two brand colours are accents, and no ornaments are added.

## Skeleton
```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Table sign</title>
<meta name="commons:page" content="210mm 297mm"><meta name="commons:format" content="A4 portrait">
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;700;800&family=Vollkorn:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--brand-color:#8391f6;--brand-accent:#c76d7e;--brand-dark:#252627;--brand-light:#fefee0;--brand-on-color:#fff;--brand-on-accent:#fff;--brand-font-heading:'Hanken Grotesk',system-ui,sans-serif;--brand-font-body:'Vollkorn',Georgia,serif}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#e9e9ee;font-family:var(--brand-font-body);color:var(--brand-dark)}
.page{width:210mm;height:297mm;margin:24px auto;background:var(--brand-light);overflow:hidden;break-after:page;display:flex;flex-direction:column;gap:10mm;padding:18mm}
h1{font-family:var(--brand-font-heading);font-size:22mm;line-height:1.02;margin:0;overflow-wrap:anywhere}
@page{size:210mm 297mm;margin:0} @media print{body{background:none}.page{margin:0}}
</style></head><body>
<section class="page">
  <img data-logo="wide" src="logo-wide.svg" alt="" style="height:16mm;width:auto;align-self:flex-start">
  <h1 data-edit="headline">Curious about AI safety?</h1>
  <p data-edit="lead">Join <span data-brand="group_name">AI Safety Aachen</span><span data-brand-own> e.V.</span> on Thursdays.</p>
  <img data-photo="members" src="photos/members.jpg" alt="Members at a table" style="width:100%;height:80mm;object-fit:cover">
  <img data-qr="join_url" alt="QR code" src="data:image/svg+xml,..." style="width:50mm;height:50mm;background:#fff;border-radius:3mm">
</section>
</body></html>
```

## Check before sharing
1. Open the result in its default look and compare it with the original, page by page: nothing missing, nothing
   drawn twice, texts at the same place.
2. Look at it as another group would. No logo and no name of the original group may remain; colours and fonts
   follow the kit; no line runs off the page. Before sharing, in a copy: put other values on the root element
   (`<html style="--brand-color:#1f6f5c;--brand-font-heading:'Fraunces'">`) and search the file for the group's name
   and logo: each one must sit in a `data-brand`, `data-brand-own`, `data-brand-other` or `data-logo` element. Once
   it is published: pick an example kit on __DEFAULT_URL__/brand and open the material.
3. Partner and sponsor logos are still there, as photo slots.
4. Every text an organizer would change can be clicked and edited, QR codes are the placeholder in the file, and
   nothing private is left (see "The file").
