import 'source-map-support/register';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as querystring from 'querystring';

import http from 'axios';
import * as ws from 'websocket';

const MINUTE = 60000;
const HOUR = MINUTE * 60;
const INTERVAL = 1000;

const ROOT = path.resolve(__dirname, '..');

type ID = '' | string & { __isID: true };

interface Config {
  server: string;
  serverport: number;
  serverid: number;

  nickname: string;
  password: string;
  room: string;

  format?: string;
  prefix?: string;
  rating?: number;
}

interface Battle {
  p1: string;
  p2: string;
  minElo: number;
}

interface LeaderboardEntry {
  name: string;
  elo: number;
  gxe: number;
  glicko: number;
  glickodev: number;
}

const CHAT = new Set(['chat', 'c', 'c:']);
const AUTH = new Set('~&#@%');

class Client {
  private readonly config: Readonly<Config>;

  private connection: ws.connection | null;
  private queue: Promise<void>;

  private format: ID;
  private prefix: ID;
  private rating: number;
  private users: Set<ID>;

  private lastid?: string;
  private leaderboard?: LeaderboardEntry[];
  private diffs?: NodeJS.Timeout;
  private started?: NodeJS.Timeout;
  private cooldown?: Date;

  constructor(config: Config) {
    this.config = config;

    this.format = toID(this.config.format);
    this.prefix = toID(this.config.prefix);
    this.rating = this.config.rating || 0;

    this.users = new Set();

    this.connection = null;
    this.queue = Promise.resolve();
  }

  connect() {
    const client = new ws.client();
    client.on('connect', this.onConnect.bind(this));
    client.on('connectFailed', this.onConnectionFailure.bind(this));
    client.connect(`ws://${this.config.server}:${this.config.serverport}/showdown/websocket`, []);
  }

  onConnect(connection: ws.connection) {
    this.connection = connection;
    const onConnectionFailure = this.onConnectionFailure.bind(this);
    connection.on('error', onConnectionFailure);
    connection.on('close', onConnectionFailure);
    connection.on('message', this.onMessage.bind(this));

    console.info('Connected to Showdown server');
  }

  onConnectionFailure(error?: Error) {
    console.error('Error occured (%s), will attempt to resconnect in a minute', error);

    setTimeout(this.connect.bind(this), MINUTE);
  }

  onMessage(message: ws.IMessage) {
    if (message.type !== 'utf8' || !message.utf8Data) return;
    const data = message.utf8Data;
    const parts = data.split('|');

    if (parts[1] === 'challstr') {
      this.onChallstr(parts);
    } else if (parts[1] === 'queryresponse') {
      this.onQueryresponse(parts);
    } else if (parts[1] === 'error') {
      console.error(new Error(parts[2]));
    } else if (CHAT.has(parts[1])) {
      this.onChat(parts);
    }
  }

  async onChallstr(parts: string[]) {
    const id = parts[2];
    const str = parts[3];

    const url = `https://play.pokemonshowdown.com/~~${this.config.serverid}/action.php`;
    const data = querystring.stringify({
      act: 'login',
      challengekeyid: id,
      challenge: str,
      name: this.config.nickname,
      pass: this.config.password,
    });

    try {
      const response = await http.post(url, data);
      const result = JSON.parse(response.data.replace(/^]/, ''));
      this.report(`/trn ${this.config.nickname},0,${result.assertion}`);
      this.report(`/join ${this.config.room}`);
      this.report('/avatar oak-gen1rb');
    } catch (err) {
      console.error(err);
      this.onChallstr(parts);
    }
  }

  onQueryresponse(parts: string[]) {
    const rooms: { [roomid: string]: Battle } = JSON.parse(parts[3]).rooms;
    const skipid = this.lastid;
    for (const [roomid, battle] of Object.entries(rooms)) {
      if (!this.tracking(battle) || (skipid && skipid >= roomid)) continue;

      const style = (p: string) => this.stylePlayer(p);
      const msg = `Battle started between ${style(battle.p1)} and ${style(battle.p2)}`;
      this.report(
        `/addhtmlbox <a href="/${roomid}" class="ilink">${msg}. (rated: ${battle.minElo})</a>`
      );
      if (!this.lastid || this.lastid < roomid) this.lastid = roomid;
    }
  }

  stylePlayer(player: string) {
    const { h, s, l } = hsl(toID(player));
    return `<strong style="color: hsl(${h},${s}%,${l}%)">${player}</strong>`;
  }

  tracking(battle: Battle) {
    const p1 = toID(battle.p1);
    const p2 = toID(battle.p2);

    // If we are tracking users and a player in the game is one of them, report the battle
    if (this.users.size && (this.users.has(p1) || this.users.has(p2))) {
      return true;
    }

    // If a player has an our prefix, report if the battle is above the required rating
    if (p1.startsWith(this.prefix) || p2.startsWith(this.prefix)) {
      return battle.minElo >= this.rating;
    }

    return false;
  }

  onChat(parts: string[]) {
    const user = parts[3];
    const message = parts.slice(4).join('|');
    const authed = AUTH.has(user.charAt(0)) || toID(user) === 'pre';
    const voiced = '+' === user.charAt(0);
    if (message.charAt(0) === '.' && (authed || voiced)) {
      console.info(`[${HHMMSS()}] ${user}: ${message.trim()}`);

      const parts = message.substring(1).split(' ');
      const command = toID(parts[0]);
      const argument = parts
        .slice(1)
        .join(' ')
        .toLowerCase()
        .trim();

      if (voiced) {
        if (command === 'leaderboard') {
          const now = new Date();
          if (!this.cooldown || +now - +this.cooldown >= HOUR) {
            this.cooldown = now;
            this.getLeaderboard(Number(argument) || 10);
          } else {
            this.report('``.leaderboard`` may only be used by voiced users once an hour.');
          }
        }
        return;
      }

      switch (command) {
        case 'format':
          const format = toID(argument);
          if (format && format !== this.format) {
            this.format = format;
            this.leaderboard = undefined;
          }
          this.report(`**Format:** ${this.format}`);
          return;
        case 'prefix':
          const prefix = toID(argument);
          if (prefix && prefix !== this.prefix) {
            this.prefix = prefix;
            this.leaderboard = undefined;
          }
          this.report(`**Prefix:** ${this.prefix}`);
          return;
        case 'elo':
        case 'rating':
          const rating = Number(argument);
          if (rating) {
            this.rating = rating;
            this.report(`/status ${this.rating}`);
          }
          this.report(`**Rating:** ${this.rating}`);
          return;
        case 'add':
        case 'track':
        case 'watch':
        case 'follow':
          for (const user of argument.split(',')) {
            this.users.add(toID(user));
          }
          this.tracked();
          return;
        case 'remove':
        case 'untrack':
        case 'unwatch':
        case 'unfollow':
          for (const user of argument.split(',')) {
            this.users.delete(toID(user));
          }
          this.tracked();
          return;
        case 'list':
        case 'tracked':
        case 'tracking':
        case 'watched':
        case 'watching':
        case 'followed':
        case 'following':
          this.tracked();
          return;
        case 'leaderboard':
          this.getLeaderboard(Number(argument) || 10);
          return;
        case 'showdiffs':
        case 'startdiffs':
        case 'unhidediffs':
          this.showdiffs(Number(argument) || 10);
          return;
        case 'unshowdiffs':
        case 'stopdiffs':
        case 'hidediffs':
          this.hidediffs();
          return;
        case 'start':
          this.start();
          return;
        case 'stop':
          this.stop();
          return;
        case 'leave':
          this.stop();
          this.report(`/leave`); // :(
          return;
      }
    }
  }

  tracked() {
    if (!this.users.size) {
      this.report(`Not currently tracking any users.`);
    } else {
      const users = Array.from(this.users.values()).join(', ');
      this.report(`Currently tracking **${this.users.size}** users: ${users}`);
    }
  }

  async getLeaderboard(num?: number) {
    const url = `https://pokemonshowdown.com//ladder/${this.format}.json`;
    const leaderboard: LeaderboardEntry[] = [];
    try {
      const response = await http.get(url);
      for (const data of response.data.toplist) {
        if (!data.userid.startsWith(this.prefix)) continue;
        leaderboard.push({
          name: data.username,
          elo: Math.floor(data.elo),
          gxe: data.gxe,
          glicko: Math.floor(data.rpr),
          glickodev: Math.floor(data.rprd),
        });
      }
      if (num) {
        const table = this.styleLeaderboard(leaderboard.slice(0, num));
        this.report(`/addhtmlbox ${table}`);
      }
    } catch (err) {
      console.error(err);
      if (num) this.report(`Unable to fetch the leaderboard for ${this.prefix}.`);
    }

    return leaderboard;
  }

  styleLeaderboard(leaderboard: LeaderboardEntry[]) {
    let buf = '<center><div class="ladder" style="max-height: 250px; overflow-y: auto"><table>';
    buf +=
      '<tr><th></th><th>Name</th><th><abbr title="Elo rating">Elo</abbr></th>' +
      '<th><abbr title="user\'s percentage chance of winning a random battle (aka GLIXARE)">GXE</abbr></th>' +
      '<th><abbr title="Glicko-1 rating system: rating±deviation (provisional if deviation>100)">Glicko-1</abbr></th></tr>';
    for (const [i, p] of leaderboard.entries()) {
      const { h, s, l } = hsl(toID(p.name));
      const link = `https://www.smogon.com/forums/search/1/?q="${encodeURIComponent(p.name)}"`;
      buf +=
        `<tr><td><a href='${link}' style="text-decoration: none; color: black;">${i + 1}</a></td>` +
        `<td><strong class='username' style="color: hsl(${h},${s}%,${l}%)">${p.name}</strong></td>` +
        `<td><strong>${p.elo}</strong></td><td>${p.gxe.toFixed(1)}%</td>` +
        `<td>${p.glicko} ± ${p.glickodev}</td></tr>`;
    }
    buf += '</table></div></center>';
    return buf;
  }

  showdiffs(num: number) {
    if (this.diffs) clearInterval(this.diffs);
    this.diffs = setInterval(async () => {
      const leaderboard = await this.getLeaderboard();
      if (!leaderboard.length) return;
      if (this.leaderboard) {
        this.reportDiff(leaderboard, num);
      }
      this.leaderboard = leaderboard;
    }, INTERVAL);
  }

  // FIXME: obviously this can be optimized...
  reportDiff(leaderboard: LeaderboardEntry[], num: number) {
    const n = Math.abs(num);
    const diffs: Map<ID, [string, number, number, number]> = new Map();

    for (const [i, prev] of this.leaderboard!.slice(0, n).entries()) {
      const id = toID(prev.name);
      const oldrank = i + 1;
      let newrank = leaderboard.findIndex(e => toID(e.name) === id) + 1;
      let elo: number;
      if (!newrank) {
        newrank = Infinity;
        elo = 0;
      } else {
        elo = leaderboard[newrank - 1].elo;
      }
      if (oldrank !== newrank) diffs.set(id, [prev.name, elo, oldrank, newrank]);
    }
    for (const [i, current] of leaderboard.slice(0, n).entries()) {
      const id = toID(current.name);
      const newrank = i + 1;
      let oldrank = this.leaderboard!.findIndex(e => toID(e.name) === id) + 1;
      if (!oldrank) oldrank = Infinity;
      if (oldrank !== newrank) diffs.set(id, [current.name, current.elo, oldrank, newrank]);
    }

    if (!diffs.size) return;

    const sorted = Array.from(diffs.values()).sort((a, b) => a[3] - b[3]);
    const messages = [];
    for (const [name, elo, oldrank, newrank] of sorted) {
      if (num < 0 && !((oldrank > n && newrank <= n) || (oldrank <= n && newrank > n))) continue;
      const symbol = oldrank < newrank ? '▼' : '▲';
      const rank = newrank === Infinity ? '?' : newrank;
      const rating = elo || '?';
      const message = newrank > n ? `__${name} (${rating})__` : `${name} (${rating})`;
      messages.push(`${symbol}**${rank}.** ${message}`);
    }

    this.report(messages.join(' '));
  }

  hidediffs() {
    if (this.diffs) {
      clearInterval(this.diffs);
      this.diffs = undefined;
      this.leaderboard = undefined;
    }
  }

  start() {
    if (this.started) return;
    this.report(`/status ${this.rating}`);
    this.started = setInterval(() => {
      const filter = this.rating && !this.users.size ? `, ${this.rating}` : '';
      this.report(`/cmd roomlist ${this.format}${filter}`);
    }, INTERVAL);
  }

  stop() {
    if (this.started) {
      clearInterval(this.started);
      this.started = undefined;
      this.report(`/status (STOPPED) ${this.rating}`);
    }
  }

  report(message: string) {
    this.queue = this.queue.then(() => {
      this.connection!.send(`${this.config.room}|${message}`.replace(/\n/g, ''));
      return new Promise(resolve => {
        setTimeout(resolve, 100);
      });
    });
  }
}

function HHMMSS() {
  const time = new Date();
  return [
    `0${time.getHours()}`.slice(-2),
    `0${time.getMinutes()}`.slice(-2),
    `0${time.getSeconds()}`.slice(-2),
  ].join(':');
}

function toID(text: any): ID {
  if (text && text.id) {
    text = text.id;
  } else if (text && text.userid) {
    text = text.userid;
  }
  if (typeof text !== 'string' && typeof text !== 'number') return '';
  return ('' + text).toLowerCase().replace(/[^a-z0-9]+/g, '') as ID;
}

// prettier-ignore
function hsl(name: string) {
  const hash = crypto.createHash('md5').update(name).digest('hex');
  // tslint:disable:ban
  const H = parseInt(hash.substr(4, 4), 16) % 360; // 0 to 360
  const S = parseInt(hash.substr(0, 4), 16) % 50 + 40; // 40 to 89
  let L = Math.floor(parseInt(hash.substr(8, 4), 16) % 20 + 30); // 30 to 49
  // tslint:enable:ban

  const C = (100 - Math.abs(2 * L - 100)) * S / 100 / 100;
  const X = C * (1 - Math.abs((H / 60) % 2 - 1));
  const m = L / 100 - C / 2;

  let R1;
  let G1;
  let B1;
  switch (Math.floor(H / 60)) {
    case 1: R1 = X; G1 = C; B1 = 0; break;
    case 2: R1 = 0; G1 = C; B1 = X; break;
    case 3: R1 = 0; G1 = X; B1 = C; break;
    case 4: R1 = X; G1 = 0; B1 = C; break;
    case 5: R1 = C; G1 = 0; B1 = X; break;
    case 0: default: R1 = C; G1 = X; B1 = 0; break;
  }
  const R = R1 + m;
  const G = G1 + m;
  const B = B1 + m;
   // 0.013 (dark blue) to 0.737 (yellow)
  const lum = R * R * R * 0.2126 + G * G * G * 0.7152 + B * B * B * 0.0722;

  let HLmod = (lum - 0.2) * -150; // -80 (yellow) to 28 (dark blue)
  if (HLmod > 18) HLmod = (HLmod - 18) * 2.5;
  else if (HLmod < 0) HLmod = (HLmod - 0) / 3;
  else HLmod = 0;
  const Hdist = Math.min(Math.abs(180 - H), Math.abs(240 - H));
  if (Hdist < 15) {
    HLmod += (15 - Hdist) / 3;
  }

  L += HLmod;
  return {h: H, s: S, l: L};
}

const client = new Client(JSON.parse(fs.readFileSync(path.resolve(ROOT, process.argv[2]), 'utf8')));
client.connect();
