# Helium Synk logo and favicon

The Helium Synk mark is derived from the official Helium icon supplied at `/Applications/Helium.app/Contents/Resources/app.icns`. It keeps the blue rounded square and white six-spoke emblem and adds two mint sync arrows. It is a project-specific derived mark. The installed application icon was read only.

## Assets and usage

| Asset                                               | Purpose                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `assets/branding/helium-synk-master.png`            | Original generated 1254 × 1254 RGBA master, with transparent outer background |
| `extension/public/icons/{16,32,48,128,256,512}.png` | Downscaled transparent PNG assets                                             |
| `extension/public/favicon.ico`                      | Multi-resolution 16/32/48 px favicon                                          |

The WXT build supplies 16/32/48/128/256/512 px installation icons and 16/32 px toolbar icons. The options dashboard uses the 128 px asset rendered at 55 px desktop/40 px narrow widths. Its adjacent wordmark names the application, so the image has an empty alt attribute. Both options and restoration pages declare PNG/ICO favicons. The high-resolution master stays outside the public directory so it is not bundled into the extension.

The built-in image generation tool produced the master using the extracted official icon as its edit target. Pillow with Lanczos resampling produced the PNG sizes and ICO container without changing the artwork. These are raster assets; no vector source is implied.

## Generation prompt

```text
Use case: compositing / logo-brand. Asset type: Helium Synk browser extension logo and favicon. Edit target: the supplied official Helium application icon. Preserve its recognizable white SIX-SPOKE Helium asterisk emblem, the exact count and orientation of its six spokes, beveled white finish, and blue rounded-square tile with dark navy top fading to periwinkle blue bottom. Add a tasteful synchronization motif: TWO bold simple mint-aqua curved arrows forming a clockwise circular orbit around the white emblem, placed INSIDE the blue tile. Scale the white emblem down modestly only as needed to leave a clear blue gap between its six tips and the arrows. Make the ring clean and balanced with only two clear triangular arrowheads at opposite points, consistent thick stroke, generous negative space. The arrows should read instantly as sync, not as a recycling triangle. Keep the original blue rounded square and white Helium identity visually dominant. No text, letters, watermarks, border badges, extra objects, decorative dots, glowing effects, or mockup. One centered isolated finished app icon, square canvas, minimal transparent outer margin, actual transparent background outside the blue rounded-square silhouette. Production quality, sharply resolved edges and clean geometry, readable down to 16–32 px. Do not supply multiple variants or a presentation sheet.
```

Built-in generation used `transparent_background: true`. The RGBA master has alpha values spanning 0–255. Package verification checked every manifest/HTML icon reference and PNG/ICO dimensions; `pnpm typecheck` and the production WXT build pass. The actual options components loaded the logo in a synthetic desktop/390 px preview with no overflow or warning/error logs. Toolbar/native Helium rendering remains part of joint browser acceptance.
