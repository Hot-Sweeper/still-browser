const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = path.join(__dirname, 'extension');
const output = path.join(__dirname, 'build');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

function catalog(name) {
  const match = main.match(new RegExp(`const ${name} = Object\\.freeze\\((\\[[\\s\\S]*?\\])\\);`));
  if (!match) throw new Error(`Could not find ${name} in the Electron source.`);
  const value = vm.runInNewContext(`(${match[1]})`, Object.create(null), { timeout: 1000 });
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} is empty.`);
  return value;
}

fs.mkdirSync(output, { recursive: true });
for (const name of fs.readdirSync(source)) {
  fs.copyFileSync(path.join(source, name), path.join(output, name));
}
for (const name of ['youtube-filter.js', 'youtube-home.js', 'youtube-ui.js']) {
  fs.copyFileSync(path.join(root, 'src', name), path.join(output, name));
}
fs.copyFileSync(path.join(root, 'src', 'start.css'), path.join(output, 'start.css'));
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'assets', 'still-icon.png'), path.join(output, 'assets', 'still-icon.png'));
fs.writeFileSync(path.join(output, 'channel-catalog.json'), JSON.stringify({
  learningChannels: catalog('learningChannels'),
  musicChannels: catalog('musicChannels')
}, null, 2));
console.log(`Built Still Firefox prototype in ${output}`);
