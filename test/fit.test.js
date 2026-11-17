'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fitHeight, settingsHeight, MIN_FIT_HEIGHT } = require('../src/main/fit.js');

const workArea = { x: 0, y: 25, width: 1440, height: 875 }; // menu bar at the top, bottom edge at 900

test('fits the content exactly', () => {
  assert.equal(fitHeight({ content: 87, top: 49, workArea }), 87); // title bar + one row
  assert.equal(fitHeight({ content: 179.4, top: 49, workArea }), 180, 'rounds up so nothing is cut off');
});

test('caps at the bottom of the screen (never moves the window up)', () => {
  assert.equal(fitHeight({ content: 2000, top: 49, workArea }), 900 - 49);
  assert.equal(fitHeight({ content: 400, top: 700, workArea }), 200);
});

test('never goes below the minimum', () => {
  assert.equal(fitHeight({ content: 20, top: 49, workArea }), MIN_FIT_HEIGHT);
  assert.equal(fitHeight({ content: 20, top: 49, workArea, min: 120 }), 120);
});

test('a window partly off-screen keeps its minimum and its top edge', () => {
  assert.equal(fitHeight({ content: 300, top: 880, workArea }), MIN_FIT_HEIGHT, 'only 20 px left below the top edge');
  assert.equal(fitHeight({ content: 300, top: 1200, workArea }), MIN_FIT_HEIGHT, 'top edge below the screen');
  assert.equal(fitHeight({ content: 300, top: -100, workArea }), 300, 'top edge above the work area');
});

test('works on a second display', () => {
  const second = { x: 1440, y: -400, width: 1920, height: 1080 }; // above-left arrangement, bottom at 680
  assert.equal(fitHeight({ content: 2000, top: -300, workArea: second }), 980);
});

test('ignores unusable measurements', () => {
  for (const content of [null, undefined, NaN, 0, -5, '200']) assert.equal(fitHeight({ content, top: 49, workArea }), null);
});

test('settings view grows a short window to min(420, room), never shrinks it', () => {
  assert.equal(settingsHeight({ height: 87, top: 49, workArea }), 420);
  assert.equal(settingsHeight({ height: 600, top: 49, workArea }), 600);
  assert.equal(settingsHeight({ height: 87, top: 700, workArea }), 200);
});
