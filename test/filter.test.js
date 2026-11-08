'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { assess, findBlocked } = require('../shared/joy-filter');

const HAPPY = [
  'A stranger paid for my coffee and left a kind note. I am smiling all day!',
  'Rescued puppy reunited with family after a month, everyone is overjoyed',
  'Volunteers plant 10,000 trees and the community celebrates together',
  'My grandmother learned to send voice notes and sent me nine just to say she loves me 💛',
  'Kids raise money to donate books to their school library, teachers thrilled',
  'Warm sunshine, a cozy garden and a happy dog. Grateful for this wonderful day',
];

const NOT_HAPPY = [
  'Man killed in shooting downtown',
  'Earthquake leaves thousands without homes',
  'Senate fails to pass bill amid outrage',
  'Hot nude pics, NSFW 18+ content inside',
  'I feel hopeless and depressed, nobody cares',
  'Celebrity dies at 54, fans mourn',
  'Heartwarming story of a hero who died saving a child', // still involves death -> blocked
  'War escalates as troops advance',
  'The worst day ever, everything is terrible and awful',
  'Company announces layoffs, stocks crash',
];

test('happy stories pass the joy filter', () => {
  for (const text of HAPPY) {
    const v = assess(text);
    assert.ok(v.ok, `expected happy: "${text}" -> ${v.reason} (score ${v.score})`);
  }
});

test('sad, violent, adult and political stories are rejected', () => {
  for (const text of NOT_HAPPY) {
    const v = assess(text);
    assert.ok(!v.ok, `expected rejection: "${text}" (score ${v.score})`);
  }
});

test('blocklist avoids false positives on similar words', () => {
  assert.strictEqual(findBlocked('A warm hug from a warrior princess'), null); // not "war"
  assert.strictEqual(findBlocked('She has amazing skills and a healthy diet'), null); // not "kill"/"die"
  assert.strictEqual(findBlocked('He played the trumpet beautifully'), null); // not "trump"
  assert.strictEqual(findBlocked('The kittens scampered across the stable'), null); // not "scam"/"stab"
  assert.strictEqual(findBlocked('The deadline is met and we celebrated'), null); // not "dead"
});

test('blocklist catches word variants', () => {
  assert.ok(findBlocked('three people were killed'));
  assert.ok(findBlocked('a stabbing was reported'));
  assert.ok(findBlocked('Wars across the region'));
});

test('negation flips positive words', () => {
  assert.ok(!assess('I am not happy, not good, not grateful at all').ok);
});

test('user muted words are respected', () => {
  assert.ok(findBlocked('My exams went great and I am so happy', ['exams']));
  assert.strictEqual(findBlocked('My exams went great and I am so happy', ['spiders']), null);
});

test('election and politics stories are rejected even when upbeat', () => {
  for (const text of [
    'Three women make history as they are elected mayor in a wonderful win',
    'Happy voters celebrate as candidate wins the governor race',
    'Inspiring campaign brings record turnout at the ballot box',
    'Proud new MP sworn in after a joyful victory for her party',
    'Prime minister celebrates amazing policy success',
  ]) {
    assert.ok(!assess(text).ok, `expected rejection: "${text}"`);
  }
});

test('politics words do not hide happy non-political stories', () => {
  for (const text of [
    "Solar met 75% of the world's electricity demand growth in 2025, a wonderful success for clean energy",
    'Kids launch a fundraising campaign and happily donate 500 books to the library',
    'Devoted volunteers celebrate a joyful day at the animal shelter',
  ]) {
    const v = assess(text);
    assert.ok(v.ok, `expected happy: "${text}" -> ${v.reason}`);
  }
});
