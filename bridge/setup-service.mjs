/**
 * Generate a macOS launchd plist (or Linux systemd unit) to keep the Feishu bridge running.
 *
 * Prerequisites:
 *   1. Create ~/.codes/bridge.json (see bridge.example.json)
 *   2. Create secret files referenced in bridge.json
 *
 * Usage:
 *   node setup-service.mjs
 *
 * Then (macOS):
 *   launchctl load ~/Library/LaunchAgents/com.codes.feishu-bridge.plist
 *
 * Or (Linux):
 *   systemctl --user enable codes-feishu-bridge
 *   systemctl --user start codes-feishu-bridge
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const NODE_PATH = process.execPath; // e.g. /opt/homebrew/bin/node or /usr/bin/node
const BRIDGE_PATH = path.resolve(import.meta.dirname, 'bridge.mjs');
const WORK_DIR = path.resolve(import.meta.dirname);

// Check bridge.json exists
const bridgeJsonPath = path.join(HOME, '.codes', 'bridge.json');
if (!fs.existsSync(bridgeJsonPath)) {
  console.error(`[ERROR] ~/.codes/bridge.json not found.`);
  console.error(`Create it first — see bridge.example.json for a template.`);
  process.exit(1);
}

// Ensure logs dir
fs.mkdirSync(`${HOME}/.codes/logs`, { recursive: true });

const platform = os.platform();

if (platform === 'darwin') {
  // ─── macOS: launchd plist ───
  const LABEL = 'com.codes.feishu-bridge';

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_PATH}</string>
      <string>${BRIDGE_PATH}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${WORK_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${HOME}</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>StandardOutPath</key>
    <string>${HOME}/.codes/logs/feishu-bridge.out.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.codes/logs/feishu-bridge.err.log</string>
  </dict>
</plist>
`;

  const outPath = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, plist);
  console.log(`Wrote: ${outPath}`);
  console.log();
  console.log('To start the service:');
  console.log(`  launchctl load ${outPath}`);
  console.log();
  console.log('To stop:');
  console.log(`  launchctl unload ${outPath}`);

} else if (platform === 'linux') {
  // ─── Linux: systemd user unit ───
  const unit = `[Unit]
Description=Codes Feishu Bridge
After=network.target

[Service]
Type=simple
ExecStart=${NODE_PATH} ${BRIDGE_PATH}
WorkingDirectory=${WORK_DIR}
Restart=always
RestartSec=5
Environment=HOME=${HOME}
Environment=PATH=/usr/local/bin:/usr/bin:/bin

StandardOutput=append:${HOME}/.codes/logs/feishu-bridge.out.log
StandardError=append:${HOME}/.codes/logs/feishu-bridge.err.log

[Install]
WantedBy=default.target
`;

  const unitDir = path.join(HOME, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const outPath = path.join(unitDir, 'codes-feishu-bridge.service');
  fs.writeFileSync(outPath, unit);
  console.log(`Wrote: ${outPath}`);
  console.log();
  console.log('To enable and start:');
  console.log('  systemctl --user daemon-reload');
  console.log('  systemctl --user enable codes-feishu-bridge');
  console.log('  systemctl --user start codes-feishu-bridge');
  console.log();
  console.log('To stop:');
  console.log('  systemctl --user stop codes-feishu-bridge');
  console.log();
  console.log('To view logs:');
  console.log('  journalctl --user -u codes-feishu-bridge -f');

} else {
  console.error(`Unsupported platform: ${platform}`);
  console.error('Manually run: node bridge.mjs');
  process.exit(1);
}
