#!/usr/bin/env node
'use strict';
/**
 * MAKES THE LOCAL TLS CERTIFICATE THE PHONE CAN TRUST (scripts/https-proxy.cjs is the server for it).
 *
 * Why a certificate at all: Android Chrome only installs a Web App from a SECURE CONTEXT. `http://
 * 192.168.1.16:7071` is not one — only https, or http to localhost. iOS never needed it, which is exactly
 * why the same page installed on one phone and refused on the other (measured, not assumed:
 * scripts/chrome-install-check.cjs prints Chrome's own `installabilityErrors` and `isSecureContext`).
 *
 * Why the SAN lists the LAN IP: a certificate is checked against the address the phone TYPES. If the cert
 * says `localhost` and the phone opens `192.168.1.16`, the identity check fails and an untrusted/invalid
 * certificate is not a secure context for an install. So this script READS the machine's own LAN address
 * (os.networkInterfaces) instead of hard-coding one — and `--san` can add more.
 *
 * 825 days: the limit browsers accept for a locally-trusted certificate. Longer and Chrome refuses it.
 * The key stays private under .gener/ (git-ignored); the CA to install on the phone is the .crt itself.
 */
const os = require('node:os');
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const OUT_DIR = path.join(REPO, '.gener', 'devcert');
const BASE = path.join(OUT_DIR, 'dev');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const extraSan = String(opt('san', '')).split(',').map((s) => s.trim()).filter(Boolean);
const days = Number(opt('days', '825'));

/** The addresses a phone on this LAN could actually type. */
const lanAddresses = () => {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      found.push(entry.address);
    }
  }
  return found;
};

const lan = lanAddresses();
if (!lan.length) {
  console.error('❌ no non-internal IPv4 found, so a phone cannot reach this box. Add --san IP.x.x.x');
  process.exit(1);
}

const san = [...lan, '127.0.0.1', 'localhost', ...extraSan]
  .map((value) => (/^\d+(\.\d+){3}$/.test(value) || /^[0-9a-f:]+$/i.test(value) ? `IP:${value}` : `DNS:${value}`))
  .join(', ');

mkdirSync(OUT_DIR, { recursive: true });
const conf = path.join(OUT_DIR, 'dev.cnf');
writeFileSync(
  conf,
  [
      /* `distinguished_name` names the SECTION that holds the subject. Writing `req` made openssl look for a
         section that does not exist, and it answered `invalid field name: name=distinguished_name` — the names
         must agree, they are not free text. */
      '[req]',
      'default_md = sha256',
      'distinguished_name = req_distinguished_name',
      'x509_extensions = v3_req',
      'prompt = no',
      '[req_distinguished_name]',
      'CN = pixoo local dev',
    '[v3_req]',
    'basicConstraints = CA:TRUE',
    'keyUsage = digitalSignature, keyEncipherment, keyCertSign',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = ${san}`,
    '',
  ].join('\n')
);

if (existsSync(`${BASE}.crt`) && !argv.includes('--force')) {
  console.log(`(exists) ${BASE}.crt — pass --force to make a new one. SANs: ${san}`);
  process.exit(0);
}

const res = spawnSync(
  'openssl',
  [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', String(days),
    '-config', conf,
    '-keyout', `${BASE}.key`,
    '-out', `${BASE}.crt`,
  ],
  { encoding: 'utf8' }
);
if (res.status !== 0) {
  console.error(`❌ openssl failed (${res.status}):\n${res.stderr || res.stdout}`);
  process.exit(1);
}

const verify = spawnSync('openssl', ['x509', '-in', `${BASE}.crt`, '-noout', '-ext'], { encoding: 'utf8' });
console.log(`✅ ${BASE}.crt + ${BASE}.key  (${days} days)`);
console.log(`   subjectAltName the phone will be checked against: ${san}`);
console.log(`   openssl says: ${(verify.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 300)}`);
console.log('\nNEXT (two steps, once per phone):');
console.log(`   1. start TLS:  node scripts/https-proxy.cjs --cert ${path.relative(REPO, BASE)}`);
console.log(`   2. trust it:   copy ${path.relative(REPO, BASE)}.crt to the phone (email/AirDrop/web upload), open it,`);
console.log(`      choose "Install a CA certificate" → Screen lock / Apps only. Until then Chrome says "Not secure",`);
console.log(`      and an untrusted certificate is not installable on Android.`);
console.log(`   Then open https://${lan[0]}:7443/api/pixoo/ui/ → menu → Install / 安裝應用程式.`);
