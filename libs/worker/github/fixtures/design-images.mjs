// Regenerates the design files of the mock GitHub (#277): small wireframe-like renders of design issue 90004,
// one per image format the Worker serves, plus one whose bytes do not match its name (the magic-byte check), and
// the text files beside them. Run from the workspace root after changing anything here:
//
//   node libs/worker/github/fixtures/design-images.mjs
//
// `sharp` is only a transitive dependency of the workspace (it arrives with the Angular build tooling, not from
// package.json): this script leans on it being present in node_modules and is run by hand, never by CI or a build.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'mock-github.json');
const REPO = 'geeera/team-console';
const FOLDER = 'docs/design/90004-demo-screen';
const PULL = 176;

/** A grey-box wireframe as SVG; `bars` are [y, height, width%] in a 100-unit grid. */
function wireframe(width, height, title, bars) {
  const unit = height / 100;
  const rects = bars
    .map(
      ([y, h, w]) =>
        `<rect x="${width * 0.06}" y="${y * unit}" width="${width * (w / 100)}" height="${h * unit}" rx="${unit * 1.2}" fill="#c9c9c9"/>`,
    )
    .join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="#f4f1ea"/>` +
      `<rect x="0" y="0" width="100%" height="${unit * 7}" fill="#e2ded4"/>` +
      `<text x="${width * 0.06}" y="${unit * 4.8}" font-family="Helvetica, Arial, sans-serif" font-size="${unit * 3.2}" fill="#333">${title}</text>` +
      rects +
      `</svg>`,
  );
}

const PHONE = [195, 422];
const MAC = [720, 450];
const PHONE_BARS = [
  [10, 6, 60],
  [18, 14, 88],
  [34, 4, 70],
  [40, 4, 50],
  [47, 14, 88],
  [63, 4, 65],
  [70, 14, 88],
];
const MAC_BARS = [
  [12, 8, 40],
  [24, 30, 88],
  [58, 6, 60],
  [68, 20, 88],
];

async function render([width, height], title, bars, format) {
  const image = sharp(wireframe(width, height, title, bars));
  switch (format) {
    case 'png':
      return image.png({ palette: true, colours: 16 }).toBuffer();
    case 'jpeg':
      return image.jpeg({ quality: 60 }).toBuffer();
    case 'webp':
      return image.webp({ quality: 60 }).toBuffer();
    case 'gif':
      return image.gif({ colours: 16 }).toBuffer();
    default:
      throw new Error(`unknown format ${format}`);
  }
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const repo = fixture.repositories[REPO];

const binaryFiles = {};
const put = (name, buffer) => {
  binaryFiles[`${FOLDER}/${name}`] = buffer.toString('base64');
};
put('phone-01-list.png', await render(PHONE, 'Designs', PHONE_BARS, 'png'));
put('phone-02-detail.png', await render(PHONE, 'Design 90004', PHONE_BARS.slice(0, 5), 'png'));
put('phone-03-answer.jpg', await render(PHONE, 'Approve?', PHONE_BARS.slice(0, 3), 'jpeg'));
put('phone-04-loading.gif', await render(PHONE, 'Loading', PHONE_BARS.slice(0, 2), 'gif'));
// Named .png, but the bytes are a GIF: the file route must refuse it (magic bytes), the viewer shows "not loaded".
put('phone-09-broken.png', await render(PHONE, 'Broken', PHONE_BARS.slice(0, 1), 'gif'));
put('mac-01-list.png', await render(MAC, 'Designs', MAC_BARS, 'png'));
put('mac-02-detail.webp', await render(MAC, 'Design 90004', MAC_BARS.slice(0, 2), 'webp'));

const textFiles = {
  [`${FOLDER}/wireframe.html`]:
    '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><title>Демо-экран (вайрфрейм)</title></head>\n' +
    '<body><h1>Демо-экран</h1><p>Интерактивный вайрфрейм дизайна #90004.</p></body></html>\n',
  [`${FOLDER}/logo.svg`]:
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>top.location="https://evil.example"</script></svg>\n',
  [`${FOLDER}/screens.json`]: JSON.stringify(
    [
      { file: 'phone-01-list.png', title: 'Список дизайнов' },
      { file: 'mac-01-list.png', title: 'Список дизайнов (Mac)' },
    ],
    null,
    2,
  ),
};

// Replace this folder's entries only; everything else in the fixture stays as it is.
const keep = (entries) => Object.fromEntries(Object.entries(entries).filter(([path]) => !path.startsWith(`${FOLDER}/`)));
repo.files = { ...keep(repo.files ?? {}), ...textFiles };
repo.binaryFiles = { ...keep(repo.binaryFiles ?? {}), ...binaryFiles };

// The open pull request that carries the design (spec §R: files are read at its head), linked by `Closes #90004`.
const pull = {
  number: PULL,
  title: 'design(#90004): demo screen wireframe and renders',
  body: 'Closes #90004\n\nWireframe and phone/Mac renders under docs/design/90004-demo-screen.',
  html_url: `https://github.com/${REPO}/pull/${PULL}`,
  draft: false,
  author_association: 'OWNER',
  user: { login: 'geeera', type: 'User' },
  state: 'open',
  // The branch lives in the project's own repository: a fork's pull request is never a design source.
  head: { sha: '17600176001760017600176001760017600176aa', ref: 'design/90004-demo-screen', repo: { full_name: REPO } },
};
repo.pulls = [pull, ...(repo.pulls ?? []).filter((item) => item.number !== PULL)];

writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  Object.entries(binaryFiles)
    .map(([path, base64]) => `${path}: ${Math.round((base64.length * 3) / 4)} bytes`)
    .join('\n'),
);
