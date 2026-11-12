#!/bin/sh
# Downloads the logo files the example groups publish on their own websites into <out dir>
# (the input of tools/build-preset-logos.mjs).
out=$1
mkdir -p "$out"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
get() { code=$(curl -sL -m 40 -A "$UA" -o "$out/$1" -w "%{http_code}" "$2"); echo "$1 $code $(wc -c < "$out/$1" | tr -d ' ') $(file -b "$out/$1" | cut -c1-70)"; }
get saarland-logo.png https://ais-saarland.org/assets/logo.png
get delft-logo.png "https://images.squarespace-cdn.com/content/v1/63e267bdc67ffc353317c986/3964fdeb-0fff-42f0-bbf9-8c1be3a5e2c1/daisi-logo.png?format=1500w"
get delft-logo-white.png "https://images.squarespace-cdn.com/content/v1/63e267bdc67ffc353317c986/c1c4cf9b-e77f-4425-a7eb-0740adf78788/daisi-logo-white.png?format=1500w"
get durham-logo.svg https://durhamaisafety.uk/images/DAISI-logo.svg
get chile-logo.svg https://aisuc.dev/_astro/ai-safety-initiative-logo.996e6868_Z12zG0N.svg
get tufts-banner.png https://tassa.dev/assets/Banner_Short.png
get tuebingen-logo.svg https://aisafetytuebingen.com/logo.svg
get tuebingen-square.svg "https://aisafetytuebingen.com/favicon.svg?v=3"
