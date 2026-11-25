// 只在构建时注入：让 vite 的 optimizeSafeRealPathSync 不再真的 spawn git
const cp = require('child_process');
const origExec = cp.exec;
cp.exec = function patchedExec(cmd, opts, cb) {
  const command = String(cmd || '');
  if (command.includes('rev-parse') || command.includes('git ')) {
    const callback = typeof opts === 'function' ? opts : cb;
    if (typeof callback === 'function') setImmediate(() => callback(new Error('disabled'), '', ''));
    const fake = { on() { return fake; }, kill() {}, stdout: null, stderr: null };
    return fake;
  }
  return origExec.apply(this, arguments);
};
cp.execSync = function patchedExecSync(cmd) {
  const command = String(cmd || '');
  if (command.includes('rev-parse')) throw new Error('disabled');
  return require('child_process').execSync;
};