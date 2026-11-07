// Keep GTK/Wayland window identity and Firefox's remote-command namespace in
// agreement with still.desktop. Do not use -no-remote for normal launches:
// subsequent links must reach the existing Still, even while Firefox is open.
function browserArgs() {
  return process.platform === 'linux' ? ['--class', 'still', '--name', 'still'] : [];
}

// GPU video decoding on NVIDIA goes through nvidia-vaapi-driver. Its direct
// backend needs the NVIDIA device nodes, which Firefox's media decoder (RDD)
// sandbox does not allow, so the sandbox is turned off only when that driver
// is installed. This was a deliberate choice: video decodes on the GPU (4K
// playback and live edges cost almost nothing) in exchange for a less
// contained decoder process. Variables already set in the environment win.
function nvidiaVideoEnv() {
  const fs = require('node:fs');
  const drivers = ['/usr/lib/dri', '/usr/lib64/dri', '/usr/lib/x86_64-linux-gnu/dri']
    .map((dir) => `${dir}/nvidia_drv_video.so`);
  if (!drivers.some((file) => fs.existsSync(file))) return {};
  return { LIBVA_DRIVER_NAME: 'nvidia', NVD_BACKEND: 'direct', MOZ_DISABLE_RDD_SANDBOX: '1' };
}

function browserEnv() {
  return process.platform === 'linux'
    ? { ...nvidiaVideoEnv(), ...process.env, MOZ_APP_REMOTINGNAME: 'still', MOZ_APP_TITLE: 'Still' }
    : { ...process.env };
}

module.exports = { browserArgs, browserEnv };
