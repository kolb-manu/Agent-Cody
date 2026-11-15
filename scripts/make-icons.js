#!/usr/bin/env node
/* Generates build/icon.png (1024x1024), used by electron-builder for the .icns / .ico app icons. */
'use strict';
const fs = require('fs');
const path = require('path');
const { mascotPNG } = require('../src/main/icon-draw.js');

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), mascotPNG(1024, { mode: 'app', color: '#8B7CF6', bg: '#171922', eye: '#171922' }));
console.log('Wrote build/icon.png');
