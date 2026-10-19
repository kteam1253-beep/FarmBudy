// torn-auto-bot.js
// Pokreni: node torn-auto-bot.js
// Postavi TORN_API_KEY u env varijablu ili u .env: TORN_API_KEY=YOUR_KEY

import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();
const KEY = process.env.TORN_API_KEY;
if (!KEY) {
  console.error('Error: postavi TORN_API_KEY u env varijablu');
  process.exit(1);
}

const BASE = 'https://api.torn.com';
const HEADER = { 'User-Agent': 'farmbuddy-torn-bot/1.0' };

async function api(path) {
  const url = `${BASE}${path}&key=${KEY}`;
  const res = await fetch(url, { headers: HEADER });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.error) throw new Error(`Torn API error: ${JSON.stringify(data.error)}`);
  return data;
}

async function getPlayer() {
  return api('/user/?selections=profile,stats,abilities');
}

async function getMarket() {
  return api('/market/?selections=items');
}

async function train(type) {
  // core Torn action se zove: /gym/234234?? Ovisi od API endpointa, ovdje je primjer
  const path = `/gym/${type}?`; // type = strength|defense
  const payload = await api(path);
  console.log('train', type, payload);
  return payload;
}

async function attack(targetID) {
  const payload = await api(`/player/${targetID}/attack?`);
  console.log('attack', targetID, payload);
  return payload;
}

function shouldTrain(player) {
  return player.stats.energy > 2;
}

function shouldAttack(player) {
  return player.stats.energy > 5 && player.stats.attack > player.stats.defense;
}

function pickTarget(candidates) {
  const sorted = candidates.sort((a,b) => a.attack - b.attack);
  return sorted[0]?.id;
}

async function mainLoop() {
  try {
    const player = await getPlayer();
    console.log(`Igrac: ${player.name} | nivo ${player.level} | energy ${player.stats.energy}`);

    if (shouldTrain(player)) {
      const trainType = player.stats.strength <= player.stats.defense ? 'strength' : 'defense';
      console.log(`Treniraj ${trainType} ...`);
      await train(trainType);
      return;
    }

    if (shouldAttack(player)) {
      const target = pickTarget([ /* Ovdje listu dohvati iz /players/active?*/ ]);
      if (target) {
        console.log(`Napada ${target} ...`);
        await attack(target);
      } else {
        console.log('Nema prihvatljivog targeta, preskacem attack.');
      }
      return;
    }

    console.log('Nedovoljno energije, stajem 30s, punoce se.');
  } catch (err) {
    console.error('Glavna petlja exception:', err.message);
  }
}

(async function () {
  console.log('Torn auto bot start');
  while (true) {
    await mainLoop();
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
})();
