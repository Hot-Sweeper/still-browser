const fs = require('node:fs');
const { launch } = require('./session');
(async () => {
  const s = await launch({ extension: false });
  try {
    await s.marionette.chrome();
    await new Promise((r) => setTimeout(r, 2500));
    const script = fs.readFileSync(process.argv[2], 'utf8');
    const result = script.includes("await ") ? await s.marionette.runAsync(`(async () => { ${script} })().then(arguments[0], (e) => arguments[0]("ERR " + e));`) : await s.marionette.run(script);
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    if (process.argv[3]) fs.writeFileSync(process.argv[3], Buffer.from(await s.marionette.screenshot(), 'base64'));
  } catch (e) { console.error(e.message); }
  await s.stop();
})();
