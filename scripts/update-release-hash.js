#!/usr/bin/env node
// Recomputes the sha512 hash and size of the signed installer and updates latest.yml.
// Run this after the installer has been signed, before publishing the GitHub release.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');

const exe = fs.readdirSync(distDir).find(f => f.endsWith('.exe'));
if (!exe) {
  console.error('No .exe found in dist/');
  process.exit(1);
}

const exePath = path.join(distDir, exe);
const data = fs.readFileSync(exePath);
const sha512 = crypto.createHash('sha512').update(data).digest('base64');
const size = data.length;

const ymlPath = path.join(distDir, 'latest.yml');
let yml = fs.readFileSync(ymlPath, 'utf8');
yml = yml.replace(/sha512: .+/g, `sha512: ${sha512}`);
yml = yml.replace(/size: \d+/g, `size: ${size}`);
fs.writeFileSync(ymlPath, yml);

console.log(`Updated latest.yml for ${exe}`);
console.log(`  sha512: ${sha512.slice(0, 20)}...`);
console.log(`  size:   ${size} bytes`);
