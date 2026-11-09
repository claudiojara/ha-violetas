#!/bin/sh
# Renders the brand PNGs from the SVG sources (needs ImageMagick 7).
# Brand rules: square, trimmed (no padding), transparent, 256 px and 512 px (@2x).
set -eu
cd "$(dirname "$0")"
out=../custom_components/violetas/brand
for variant in "" dark_; do
  src=violetas-icon${variant:+-dark}.svg
  for size in 256 512; do
    if [ "$size" = 512 ]; then name=${variant}icon@2x.png; else name=${variant}icon.png; fi
    magick -background none -density 1200 "$src" -trim +repage -resize ${size}x${size} \
      -gravity center -background none -extent ${size}x${size} -strip png32:"$out/$name"
  done
done
