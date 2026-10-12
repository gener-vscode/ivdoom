#!/usr/bin/env node
/*
 * Where the panel address comes from, in ONE place.
 *
 * `local.settings.json` used to hold it. That file is the Azure Functions host's config, and this repo has
 * no Functions host (`src/host/server.ts` owns the port; see AGENTS.md). A panel's LAN address is a property
 * of the machine it sits on, so it belongs in a gitignored file - not in a tracked file, and not in a file
 * named after a host this repo does not run.
 *
 * Precedence, same for every caller: `--origin` on the command line, then PIXOO_ORIGIN in the environment,
 * then this file. Those two overrides are each script's own argument handling; only the READING of the file
 * is shared, so no second copy of the parser exists.
 */
const fs = require('node:fs');
const path = require('node:path');

/** repo-relative, for messages; .gener/ is gitignored, so a LAN address never lands in a commit */
const DEVICE_CONFIG_REL = '.gener/device.json';
const DEVICE_CONFIG_PATH = path.join(__dirname, '..', '.gener', 'device.json');

/** `{}` when the file is absent or unreadable: absence is reported by the caller that NEEDS an origin. */
const deviceValues = () => {
  try {
    return JSON.parse(fs.readFileSync(DEVICE_CONFIG_PATH, 'utf8')).Values ?? {};
  } catch {
    return {};
  }
};

/** The sentence every caller prints when there is no origin - one wording, not three. */
const noOriginMessage = (flag = '--origin') =>
  `PIXOO_ORIGIN not found: pass ${flag} http://<panel-ip>, set PIXOO_ORIGIN, or write ` +
  `${DEVICE_CONFIG_REL} as {"Values":{"PIXOO_ORIGIN":"http://<panel-ip>"}}`;

module.exports = { DEVICE_CONFIG_REL, DEVICE_CONFIG_PATH, deviceValues, noOriginMessage };

/* `yarn device` - answers the question "would a run find the panel?" without touching the panel. */
if (require.main === module) {
  const values = deviceValues();
  const exists = fs.existsSync(DEVICE_CONFIG_PATH);
  console.log(`device config  ${DEVICE_CONFIG_REL}  ${exists ? 'present' : 'ABSENT'}`);
  console.log(`PIXOO_ORIGIN  ${values.PIXOO_ORIGIN ?? '(not set here; --origin or the environment would win)'}`);
  if (!values.PIXOO_ORIGIN) console.log(noOriginMessage());
}
