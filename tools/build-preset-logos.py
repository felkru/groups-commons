"""Builds the logo files of the example brand kits (public/assets/presets/) from the files each group publishes
on its own website. Kairos may reuse the groups' logos and materials for its marketing and operations; the files
are part of the site, not of the public repository (see .gitignore).

Usage: python3 tools/build-preset-logos.py <folder with the downloaded files> <output folder>

Each kit gets up to four files: square and wide, each for light and for dark backgrounds. Where a group publishes
only a mark, the wide logo is that mark next to the group's name, the way the generated logos are laid out.
"""
import base64, json, os, shutil, subprocess, sys

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
read = lambda name: open(os.path.join(src, name), 'rb').read()
text = lambda name: read(name).decode('utf-8')
def write(name, data):
    open(os.path.join(out, name), 'wb' if isinstance(data, bytes) else 'w').write(data)
    return '/assets/presets/' + name
def ffmpeg(name_in, name_out, vf):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', os.path.join(src, name_in), '-vf', vf, os.path.join(out, name_out)], check=True)
    return '/assets/presets/' + name_out
def data_uri(path_or_bytes, mime):
    data = path_or_bytes if isinstance(path_or_bytes, bytes) else open(path_or_bytes, 'rb').read()
    return f'data:{mime};base64,' + base64.b64encode(data).decode('ascii')
def beside_name(mark_uri, name, ink, font):
    width = 250 + round(len(name) * 44)
    safe = name.replace('&', '&amp;').replace('<', '&lt;')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 200">'
            f'<image href="{mark_uri}" x="0" y="0" width="200" height="200" preserveAspectRatio="xMidYMid meet"/>'
            f'<text x="236" y="126" font-family="{font}" font-weight="700" font-size="78" fill="{ink}">{safe}</text></svg>')
SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif"
SERIF = "Georgia, 'Times New Roman', serif"

logos = {}

# Harvard AI Safety Team: hourglass icon and the AIST wordmark from the page header (drawn in the text colour).
wordmark = text('harvard-header.svg').replace(' class="brand-mark"', '').replace(' aria-hidden="true"', '')
logos['harvard'] = {
    'square': write('harvard-square.png', read('harvard-square.png')),
    'wide': write('harvard-wide.svg', wordmark.replace('currentColor', '#1b1f1f')),
    'wide_light': write('harvard-wide-light.svg', wordmark.replace('currentColor', '#ffffff')),
}
# Oxford AI Safety Initiative: both marks carry their own orange background.
logos['oxford'] = {'square': write('oxford-square.svg', read('oxford-square.svg')), 'wide': write('oxford-wide.svg', read('oxford-wide.svg'))}
# Cambridge AI Safety Hub: one black mark; white for dark backgrounds.
write('cambridge-square.png', read('cambridge-logo.png'))
ffmpeg('cambridge-logo.png', 'cambridge-square-light.png', 'format=rgba,negate=negate_alpha=0')
logos['cambridge'] = {
    'square': '/assets/presets/cambridge-square.png',
    'square_light': '/assets/presets/cambridge-square-light.png',
    'wide': write('cambridge-wide.svg', beside_name(data_uri(read('cambridge-logo.png'), 'image/png'), 'Cambridge AI Safety Hub', '#1a1a1a', SERIF)),
    'wide_light': write('cambridge-wide-light.svg', beside_name(data_uri(os.path.join(out, 'cambridge-square-light.png'), 'image/png'), 'Cambridge AI Safety Hub', '#ffffff', SERIF)),
}
# Stanford AI Governance & Alignment: the published wordmark is cream, for dark backgrounds.
saga = text('stanford-logo.svg')
logos['stanford'] = {
    'square': write('stanford-square.svg', read('stanford-square.svg')),
    'wide': write('stanford-wide.svg', saga.replace('#FFF5EB', '#2f0115')),
    'wide_light': write('stanford-wide-light.svg', saga),
}
# Toronto AI Safety Initiative: a mark only.
ffmpeg('toronto-square.png', 'toronto-square.png', 'scale=256:256')
mark = data_uri(os.path.join(out, 'toronto-square.png'), 'image/png')
logos['toronto'] = {
    'square': '/assets/presets/toronto-square.png',
    'wide': write('toronto-wide.svg', beside_name(mark, 'Toronto AI Safety Initiative', '#1b0630', SANS)),
    'wide_light': write('toronto-wide-light.svg', beside_name(mark, 'Toronto AI Safety Initiative', '#ffffff', SANS)),
}
# NTU AI Safety: bell mark and a dark green wordmark.
bell = data_uri(read('ntu-square.svg'), 'image/svg+xml')
logos['ntu'] = {
    'square': write('ntu-square.svg', read('ntu-square.svg')),
    'wide': ffmpeg('ntu-logo.png', 'ntu-wide.png', 'scale=1200:-1'),
    'wide_light': write('ntu-wide-light.svg', beside_name(bell, 'NTU AI Safety', '#ffffff', SANS)),
}
# AI Safety Tübingen: boat mark; the wordmark is near-black.
boat = text('tuebingen-logo.svg')
logos['tuebingen'] = {
    'square': write('tuebingen-square.svg', read('tuebingen-square.svg')),
    'wide': write('tuebingen-wide.svg', boat),
    'wide_light': write('tuebingen-wide-light.svg', boat.replace('#1d1d1b', '#ffffff')),
}
print(json.dumps(logos, indent=1))
