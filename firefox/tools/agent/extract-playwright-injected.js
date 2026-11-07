// Pull Playwright's injected script source string out of coreBundle.js without running the bundle.
const fs = require('fs'); const acorn = require("acorn");
const [bundle, out] = process.argv.slice(2);
const text = fs.readFileSync(bundle, 'utf8');
const marker = 'injectedScriptSource.ts"() {';
const at = text.indexOf(marker); const start = text.indexOf("source5 = ", at) + "source5 = ".length;
const node = acorn.parseExpressionAt(text, start, { ecmaVersion: 'latest' });
if (node.type !== 'Literal' || typeof node.value !== 'string') throw new Error('not a string literal: ' + node.type);
fs.writeFileSync(out, node.value); console.log('chars', node.value.length);
