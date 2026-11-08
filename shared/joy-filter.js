(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JoyFilter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * Happyness "joy filter".
 *
 * Every piece of content (news headline, Reddit post, community story) passes
 * through `assess()` before it can appear in the feed. It works in two stages:
 *
 *   1. Hard block  – if the text touches anything on the blocklist (adult
 *                    content, violence, death, self-harm, war, disasters,
 *                    outrage politics...), it is rejected outright, no matter
 *                    how positive the rest of it sounds.
 *   2. Joy score   – remaining text is scored with weighted positive and
 *                    negative word lists. Only content that is clearly
 *                    positive passes.
 *
 * Being strict is intentional: it is far better to hide a happy story by
 * mistake than to show a sad one.
 */

// Anything matching these is never shown. Matched on word starts, so
// "kill" also catches "killed", "killing", "killer".
const BLOCKED = [
  // adult / sexual
  'nsfw', 'nude', 'nudes', 'naked', 'porn', 'sex', 'sexual', 'sexy', 'onlyfans', 'xxx',
  'explicit', 'erotic', 'fetish', 'strip club', 'escort', 'hookup', 'horny', 'lingerie',
  'boob', 'thirst trap', '18+', 'nsfl',
  // death, violence, crime
  'death', 'dead', 'die', 'died', 'dies', 'dying', 'kill', 'murder', 'homicide', 'stabbed', 'stabbing', 'bombed', 'bombing', 'manslaughter',
  'shooting', 'shooter', 'gunman', 'gunfire', 'shot dead', 'stab', 'massacre', 'slaughter',
  'assault', 'rape', 'abuse', 'abused', 'molest', 'torture', 'kidnap', 'hostage', 'trafficking',
  'violence', 'violent', 'brutal', 'bloody', 'corpse', 'body found', 'remains found',
  'fatal', 'fatality', 'funeral', 'obituary', 'passed away', 'rip ', 'mourn', 'grief', 'grieving',
  'crime', 'criminal', 'arrest', 'jail', 'prison', 'sentenced', 'convicted', 'police chase',
  'terror', 'bomb', 'explosion', 'weapon',
  // self-harm & mental-health triggers
  'suicide', 'suicidal', 'self-harm', 'self harm', 'overdose', 'eating disorder', 'anorexia',
  'bulimia', 'cutting myself', 'hopeless', 'worthless', 'want to disappear', 'end it all',
  'depressed', 'depression', 'anxiety attack', 'panic attack', 'lonely', 'loneliness',
  // war & conflict
  'war', 'wars', 'warfare', 'missile', 'airstrike', 'invasion', 'troops', 'military strike',
  'genocide', 'refugee crisis', 'casualties', 'conflict',
  // disasters & disease
  'disaster', 'earthquake', 'tsunami', 'hurricane', 'wildfire', 'flood', 'famine', 'drought',
  'pandemic', 'outbreak', 'epidemic', 'cancer', 'tumor', 'terminal', 'crash', 'collapse',
  'tragedy', 'tragic', 'catastroph', 'devastat', 'victim',
  // outrage, politics & doom
  'election', 'trump', 'biden', 'republican', 'democrat', 'parliament', 'senate', 'congress',
  'elected', 'elects', 'electoral', 'reelect', 're-elect', 'vote', 'voter', 'voting', 'ballot', 'polls', 'polling station',
  'campaign trail', 'election campaign', 'candidate', 'mayor', 'governor', 'minister', 'president', 'politic', 'party leader',
  'lawmaker', 'legislat', 'congressman', 'congresswoman', 'senator', 'mp ', 'mps', 'cabinet',
  'government', 'administration', 'policy', 'policies', 'referendum', 'sworn in', 'inaugurat',
  'white house', 'downing street', 'kremlin', 'tariff', 'sanction', 'gop', 'labour party', 'tory', 'bjp',
  'scandal', 'outrage', 'furious', 'slams', 'blasts', 'backlash', 'controversy', 'lawsuit',
  'layoff', 'recession', 'inflation', 'crisis', 'collapse', 'doom', 'apocalypse', 'scam', 'fraud',
  'racist', 'racism', 'hate', 'hateful', 'harass', 'bully', 'cheated', 'divorce', 'breakup',
];

// Weighted joy vocabulary. Higher weight = stronger positive signal.
const POSITIVE = {
  // strong
  joy: 3, joyful: 3, delight: 3, delighted: 3, wholesome: 3, heartwarming: 3, uplifting: 3,
  inspiring: 3, inspirational: 3, celebrate: 3, celebrates: 3, celebrated: 3, celebration: 3,
  kindness: 3, kind: 2, generous: 3, generosity: 3, hero: 2, heroes: 2, miracle: 2,
  grateful: 3, gratitude: 3, thankful: 3, blessed: 2, overjoyed: 3, thrilled: 3, ecstatic: 3,
  adorable: 3, cute: 2, smile: 3, smiles: 3, smiling: 3, laugh: 2, laughter: 3, happy: 3,
  happiness: 3, happiest: 3, love: 2, loved: 2, loving: 2, beautiful: 2, wonderful: 3, amazing: 2,
  awesome: 2, incredible: 2, brilliant: 2, fantastic: 2, proud: 2, success: 2, successful: 2,
  // medium
  reunite: 3, reunited: 3, reunion: 3, rescue: 2, rescued: 2, adopted: 2, adopt: 2, adoption: 2,
  donate: 2, donated: 2, donation: 2, volunteer: 2, volunteers: 2, charity: 2, helped: 2, helps: 1,
  help: 1, hope: 2, hopeful: 2, hug: 2, hugs: 2, friendship: 2, friend: 1, friends: 1, together: 1,
  community: 1, neighbor: 1, neighbors: 1, neighbour: 1, neighbours: 1, surprise: 1, surprised: 1,
  gift: 2, gifts: 2, win: 1, wins: 1, won: 1, award: 1, achieve: 2, achieved: 2, achievement: 2,
  milestone: 2, graduate: 2, graduated: 2, graduation: 2, recover: 2, recovered: 2, recovery: 1,
  thrive: 2, thriving: 2, flourish: 2, bloom: 1, restored: 2, restore: 1, protect: 1, protected: 1,
  breakthrough: 2, discover: 1, discovered: 1, cure: 2, healed: 2, healthy: 1, puppy: 2, puppies: 2,
  kitten: 2, kittens: 2, baby: 1, babies: 1, dog: 1, cat: 1, birthday: 2, wedding: 2, married: 1,
  first: 1, record: 1, saved: 2, saves: 2, record_breaking: 2, free: 1, fun: 2, dream: 1,
  dreams: 1, peaceful: 2, calm: 1, cozy: 2, sunshine: 2, garden: 1, planted: 1, trees: 1, clean: 1,
  sweet: 2, nice: 1, good: 1, great: 1, best: 1, glad: 2, fresh: 1, bright: 1, warm: 1, cheer: 2,
  cheered: 2, cheers: 1, applause: 2, wholesomeness: 3, renewable: 1, solar: 1, recycled: 1,
  goodwill: 2, lovely: 2, grinning: 2, grin: 2, thank: 2, thanks: 2, superhero: 2, faith: 1,
  laughing: 2, laughed: 2, giggle: 2, giggled: 2, delightful: 3, magical: 2, precious: 2,
  compassion: 2, compassionate: 2, empathy: 2, caring: 2, cares: 1, gentle: 1,
};

// Words that reduce the score (but don't block outright).
const NEGATIVE = {
  sad: -3, sadly: -2, cry: -1, crying: -1, tears: -1, pain: -2, painful: -2, hurt: -2,
  injured: -2, injury: -2, sick: -2, illness: -2, disease: -2, hospital: -1, fear: -2,
  afraid: -2, scared: -2, scary: -2, worry: -2, worried: -2, angry: -3, anger: -3, mad: -2,
  bad: -2, worse: -2, worst: -3, terrible: -3, horrible: -3, awful: -3, ugly: -2, fail: -2,
  failed: -2, failure: -2, lose: -1, lost: -1, loss: -2, losing: -1, broke: -2, broken: -2,
  poor: -1, poverty: -2, struggle: -1, struggling: -2, threat: -2, threaten: -2, danger: -2,
  dangerous: -2, warning: -2, warns: -2, risk: -1, problem: -1, problems: -1, missing: -2,
  attack: -3, fight: -2, fighting: -2, protest: -2, ban: -1, banned: -1, cut: -1, cuts: -1,
  shame: -2, ashamed: -2, guilty: -2, regret: -2, stress: -2, stressed: -2, toxic: -3,
  disgusting: -3, horror: -3, nightmare: -3, alone: -1, stupid: -2, idiot: -3, hate: -3,
  never: -1, nobody: -1, ruined: -3, destroy: -3, destroyed: -3, fired: -2, evicted: -3,
  debt: -2, homeless: -1, cringe: -1, rant: -2, unpopular: -1, drama: -2, wtf: -2,
};

// Phrases that flip a following positive word ("not happy", "no hope").
const NEGATORS = new Set(['not', 'no', 'never', "don't", 'dont', "isn't", 'isnt', "wasn't", 'wasnt', 'without', 'hardly', "can't", 'cant', 'cannot', 'nothing']);

const MIN_SCORE = 2;          // must be at least this positive overall
const MIN_RATIO = 0.75;       // positive weight must dominate negative weight

function normalize(text) {
  return ` ${String(text || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'+\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pre-compile blocklist regexes: match at a word start.
const BLOCK_PATTERNS = BLOCKED.map((term) => ({
  term: term.trim(),
  re: new RegExp(`(^|[^a-z0-9])${escapeRe(term.trim())}`, 'i'),
}));

// Short block terms that must match as whole words only (avoid "warm" -> "war",
// "diet" -> "die", "sextet" -> "sex", "cutest" -> nothing, etc.).
const WHOLE_WORD_ONLY = new Set(['mp', 'mps', 'polls', 'gop', 'tory', 'bjp', 'war', 'wars', 'die', 'died', 'dies', 'dead', 'sex', 'hate', 'rip', 'xxx', 'crash', 'stab', 'kill', 'bomb', 'trump', 'scam', 'sexy']);
for (const p of BLOCK_PATTERNS) {
  if (WHOLE_WORD_ONLY.has(p.term)) {
    p.re = new RegExp(`(^|[^a-z0-9])${escapeRe(p.term)}(?![a-z0-9])`, 'i');
  }
}
// 'kill' should still catch killed/killing/killer but not "skill".
BLOCK_PATTERNS.push({ term: 'kill*', re: /(^|[^a-z0-9])kill(ed|ing|er|ers|s)\b/i });

/**
 * Find the first blocked term in a piece of text, or null.
 * @param {string} text
 * @param {string[]} [extraTerms] user-supplied muted words
 */
function findBlocked(text, extraTerms = []) {
  const norm = normalize(text);
  for (const { term, re } of BLOCK_PATTERNS) {
    if (re.test(norm)) return term;
  }
  for (const raw of extraTerms) {
    const t = normalize(raw).trim();
    if (t && new RegExp(`(^|[^a-z0-9])${escapeRe(t)}`, 'i').test(norm)) return t;
  }
  return null;
}

// Emoji lists are matched as whole sequences (some include an invisible
// variation selector, so a character class would mis-count them).
const HAPPY_EMOJI = ['😀', '😃', '😄', '😁', '😆', '😊', '🙂', '🥰', '😍', '🤗', '🥳', '🎉', '💖', '💕', '❤', '🧡', '💛', '💚', '💙', '💜', '🌈', '🌻', '🌸', '☀', '✨', '🐶', '🐱', '👏', '🙌', '🤩', '😇', '🌞', '💐', '🌱', '🦆', '🎈', '🎂'];
const SAD_EMOJI = ['😢', '😭', '😞', '😔', '😟', '😠', '😡', '🤬', '💔', '😩', '😫', '😰', '😨', '☹', '🙁'];

function countEmoji(text, list) {
  const s = String(text || '');
  let n = 0;
  for (const e of list) n += s.split(e).length - 1;
  return n;
}

/**
 * Score the "joy" in a piece of text.
 * @returns {{score:number, positive:number, negative:number, matches:string[]}}
 */
function joyScore(text) {
  const words = normalize(text).trim().split(' ').filter(Boolean);
  let positive = 0;
  let negative = 0;
  const matches = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^'+|'+$/g, '');
    const negated = (i > 0 && NEGATORS.has(words[i - 1])) || (i > 1 && NEGATORS.has(words[i - 2]));
    if (Object.prototype.hasOwnProperty.call(POSITIVE, w)) {
      if (negated) negative += POSITIVE[w];
      else { positive += POSITIVE[w]; matches.push(w); }
    } else if (Object.prototype.hasOwnProperty.call(NEGATIVE, w)) {
      if (negated) positive += 0.5; // "not bad" -> mildly ok
      else negative += -NEGATIVE[w];
    }
  }
  // Emojis are a strong signal in social posts.
  const happyEmoji = countEmoji(text, HAPPY_EMOJI);
  const sadEmoji = countEmoji(text, SAD_EMOJI);
  positive += happyEmoji * 2;
  negative += sadEmoji * 3;
  return { score: positive - negative, positive, negative, matches };
}

/**
 * Decide whether a piece of content is happy enough for the feed.
 * @param {string} text
 * @param {{extraBlocked?: string[], minScore?: number}} [opts]
 * @returns {{ok:boolean, reason:string, score:number, blocked:string|null}}
 */
function assess(text, opts = {}) {
  const blocked = findBlocked(text, opts.extraBlocked || []);
  if (blocked) {
    return { ok: false, reason: `contains a filtered topic ("${blocked}")`, score: -Infinity, blocked };
  }
  const { score, positive, negative } = joyScore(text);
  const minScore = opts.minScore ?? MIN_SCORE;
  if (score < minScore) {
    return { ok: false, reason: 'not uplifting enough', score, blocked: null };
  }
  if (positive === 0 || negative / positive > 1 - MIN_RATIO) {
    return { ok: false, reason: 'too mixed in tone', score, blocked: null };
  }
  return { ok: true, reason: 'uplifting', score, blocked: null };
}

return { assess, joyScore, findBlocked, normalize };
});
