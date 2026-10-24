// Raster assets and the core atlas share these editable, font-independent SVGs.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const at = path => new URL(path, import.meta.url);
const symbol = await readFile(at('../../branding/ppsspw-symbol.svg'), 'utf8');
const wordmark = await readFile(at('../../branding/ppsspw-wordmark.svg'), 'utf8');
const body = svg => svg.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/g, '').trim();
const wrap = (width, height, content) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${content}\n</svg>\n`;
const mark = body(symbol);
const tile = maskable => wrap(512, 512, `<title>PPSSPW</title>\n<rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="#181d23"/>\n<g transform="translate(${maskable ? 72 : 0} ${maskable ? 72 : 0}) scale(${maskable ? 0.71875 : 1})">${mark}</g>`);
const output = at('../public/icons/');
await mkdir(output, { recursive: true });
await writeFile(at('../public/icons/ppsspw-symbol.svg'), symbol);
await writeFile(at('../public/icons/ppsspw.svg'), tile(false));
for (const size of [32, 192, 512]) {
  const png = new Resvg(tile(false), { fitTo: { mode: 'width', value: size } }).render().asPng();
  await writeFile(at(`../public/icons/ppsspw-${size}.png`), png);
}
for (const size of [192, 512]) {
  const png = new Resvg(tile(true), { fitTo: { mode: 'width', value: size } }).render().asPng();
  await writeFile(at(`../public/icons/ppsspw-${size}-maskable.png`), png);
}
await writeFile(at('../../deps/ppsspp-wasm/assets/ui_images/ppsspw.png'), new Resvg(tile(false), { fitTo: { mode: 'width', value: 72 } }).render().asPng());
// NanoSVG inherits each group's ID; the core extracts these three atlas entries.
// Matching the upstream icon/wordmark sizes preserves existing menu geometry.
const atlas = wrap(240, 144, `<g id="I_ICON" transform="translate(2 2) scale(0.140625)">${body(tile(false))}</g>\n<g id="I_ICON_GOLD" transform="translate(82 2) scale(0.140625)">${body(tile(false))}</g>\n<g id="I_LOGO" transform="translate(2 94) scale(0.45454545)">${body(wordmark)}</g>`);
const atlasPath = at('../../deps/ppsspp-wasm/assets/ui_images/ppsspw.svg');
await writeFile(atlasPath, atlas);
console.log(`Generated PPSSPW web icons and ${fileURLToPath(atlasPath)}`);
