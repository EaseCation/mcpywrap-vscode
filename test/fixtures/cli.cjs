// Independent CLI fixture. Never imports or launches mcpy or a game.
const args = process.argv.slice(2);
const mode = args[0];
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'invalid') process.stdout.write('progress is not JSON');
else if (mode === 'missing-ok') process.stdout.write('{"state":"running"}');
else if (mode === 'contradiction') { process.stdout.write('{"ok":true}'); process.exitCode = 2; }
else if (mode === 'failed') { process.stdout.write('{"ok":false,"error":"fixture failure","code":"busy"}'); process.exitCode = 1; }
else if (mode === 'unicode') {
  const data = Buffer.from(JSON.stringify({ ok: true, text: '中文 · 世界 🌍' }));
  process.stderr.write('progress: ignored');
  let index = 0;
  const timer = setInterval(() => {
    process.stdout.write(data.subarray(index, index + 1));
    if (++index === data.length) clearInterval(timer);
  }, 1);
} else if (mode === 'overflow') process.stdout.write('x'.repeat(9 * 1024 * 1024));
else process.stdout.write(JSON.stringify({ ok: true, args, cwd: process.cwd() }));
