# RichiRoute logo

An R drawn as one route line that ends at a waypoint: what the app does, in its own look. The line has the
rounded ends of the route on the map; a gap rings the waypoint, as the white ring does the app's stop markers.

## Files
| Folder | What | Use |
|---|---|---|
| `symbol/` | the mark alone: colour, reversed, ink, black, white | wherever the name stands beside it anyway |
| `symbol/*-small*` | heavier line, wider ring | below 32 px only |
| `lockup/` | horizontal and stacked, with the name, in the same colours | website header, documents, App Store page |
| `app-icon/` | the icon, flat, 1024 px | the web and the App Store page |
| `../../ios/RichiRoute/AppIcon.icon` | the iPhone icon (Icon Composer): ink behind, route and waypoint as glass layers, the waypoint in front | the app; iOS makes the dark, tinted and clear looks |

All files are outlines: no live text, no strokes, no effects.

## Clear space and minimum size
Keep free, all around the mark (not the file's edge), at least the diameter of the waypoint. The symbol from 32 px (16–31 px: the `small` version),
the horizontal lockup from 120 px wide, the stacked one from 64 px.

## Colours
| Name | HEX | Use |
|---|---|---|
| Ink | `#121816` | the line on light backgrounds; the icon's background |
| Light ink | `#e6ebe9` | the line on dark backgrounds |
| Route green | `#0b7d58` | the waypoint only, the one spot of colour |

Allowed: colour on white · reversed on ink or black · ink, black or white in one colour. On photos and maps only on
a calm area, or in the icon's ink square.

## Typeface
The name is Noto Sans Bold (SIL Open Font License), turned into outlines. The app and the web planner use the system
font (SF Pro on Apple), which is not licensed for logos: never set the name anew, use the lockup files.

## Don'ts
Don't stretch, rotate or recolour · don't make the waypoint another colour than green, ink, black or white · don't
close the ring around the waypoint · don't add shadows, outlines or gradients · don't move the name against the symbol.

## Rebuilding
`build.py` writes every file here and the shapes of the app's icon (`AppIcon.icon/Assets`) from the construction at
its top; the icon's look (fill, glass, shadow) is its `icon.json`, edited in Xcode's Icon Composer. From `app/`:

```sh
python3 -m venv .cache/logo-venv && .cache/logo-venv/bin/pip install -r design/logo/requirements.txt
.cache/logo-venv/bin/python design/logo/build.py
```

It reads Noto Sans Bold from `/usr/share/fonts/truetype/noto/`; elsewhere, name the font file in
`RICHIROUTE_LOGO_FONT`. To see the iPhone icon in each look on a Mac, open `AppIcon.icon` in Icon Composer, or:
`"/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool" AppIcon.icon
--export-image --output-file icon.png --platform iOS --rendition Dark --width 1024 --height 1024 --scale 1`
(renditions: Default, Dark, TintedLight, TintedDark, ClearLight, ClearDark).
