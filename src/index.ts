import 'source-map-support/register';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as querystring from 'querystring';

import http from 'axios';
import * as ws from 'websocket';

const MINUTE = 60000;
const INTERVAL = 1000;
const FACTOR = 1.5;
const TOKEN = '.';

const ROOT = path.resolve(__dirname, '..');

type ID = '' | string & { __isID: true };

interface Config {
  server: string;
  serverport: number;
  serverid: number;

  nickname: string;
  avatar?: string;
  password: string;
  room: string;

  format?: string;
  prefix?: string;
  rating?: number;
  deadline?: string;
  cutoff?: number;
}

interface Battle {
  p1: string;
  p2: string;
  minElo: number;
}

interface Leaderboard {
  current?: LeaderboardEntry[];
  last?: LeaderboardEntry[];
  // NB: non prefixed
  lookup: Map<ID, LeaderboardEntry>;
}

interface LeaderboardEntry {
  name: string;
  rank?: number;
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
  private deadline?: Date;
  private rating: number;
  private users: Set<ID>;

  private lastid?: string;
  private showdiffs?: boolean;
  private started?: NodeJS.Timeout;
  private final?: NodeJS.Timeout;

  private leaderboard: Leaderboard;
  private loggedin: boolean;

  private cooldown?: Date;
  private changed?: boolean;
  private lines: { them: number; total: number };

  constructor(config: Readonly<Config>) {
    this.config = config;
    this.connection = null;
    this.queue = Promise.resolve();

    this.format = toID(config.format);
    this.prefix = toID(config.prefix);
    this.rating = config.rating || 0;
    if (config.deadline) this.setDeadline(config.deadline);

    this.users = new Set();
    this.leaderboard = { lookup: new Map() };
    this.showdiffs = false;
    this.loggedin = false;

    this.lines = { them: 0, total: 0 };
  }

  setDeadline(argument: string) {
    const date = new Date(argument);
    if (!+date) return;

    this.deadline = date;
    if (this.final) clearTimeout(this.final);
    // We set the timer to fire slightly before the deadline and then
    // repeatedly do process.nextTick checks for accuracy
    this.final = setTimeout(() => {
      this.stop();
      this.captureFinalLeaderboard();
    }, +this.deadline - Date.now() - 500);
  }

  async captureFinalLeaderboard() {
    const now = new Date();
    if (now < this.deadline!) {
      process.nextTick(this.captureFinalLeaderboard.bind(this));
      return;
    }
    const leaderboard = await this.getLeaderboard();
    this.report(`/addhtmlbox ${this.styleLeaderboard(leaderboard, +now)}`);
    this.deadline = undefined;
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
    } else if (parts[1] === 'init') {
      this.loggedin = true;
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
      if (this.config.avatar) this.report(`/avatar ${this.config.avatar}`);
      this.start();
    } catch (err) {
      console.error(err);
      this.onChallstr(parts);
    }
  }

  onQueryresponse(parts: string[]) {
    const rooms: { [roomid: string]: Battle } = JSON.parse(parts[3]).rooms;
    const skipid = this.lastid;
    for (const [roomid, battle] of Object.entries(rooms)) {
      const [rating, rmsg] = this.getRating(battle);
      if (!this.tracking(battle, rating) || (skipid && skipid >= roomid)) continue;

      const style = (p: string) => this.stylePlayer(p);
      const msg = `Battle started between ${style(battle.p1)} and ${style(battle.p2)}`;
      this.report(`/addhtmlbox <a href="/${roomid}" class="ilink">${msg}. ${rmsg}</a>`);
      if (!this.lastid || this.lastid < roomid) this.lastid = roomid;
    }
  }

  getRating(battle: Battle): [number, string] {
    const p1 = this.leaderboard.lookup.get(toID(battle.p1));
    const p2 = this.leaderboard.lookup.get(toID(battle.p2));
    if (p1 && p2) return this.averageRating(p1.elo, p2.elo);
    if (p1 && p1.elo > battle.minElo) return this.averageRating(p1.elo, battle.minElo);
    if (p2 && p2.elo > battle.minElo) return this.averageRating(p2.elo, battle.minElo);
    return [battle.minElo, `(min rating: ${battle.minElo})`];
  }

  averageRating(a: number, b: number): [number, string] {
    const rating = Math.round((a + b) / 2);
    return [rating, `(avg rating: ${rating})`];
  }

  stylePlayer(player: string) {
    const { h, s, l } = hsl(toID(player));
    return `<strong style="color: hsl(${h},${s}%,${l}%)">${player}</strong>`;
  }

  tracking(battle: Battle, rating: number) {
    const p1 = toID(battle.p1);
    const p2 = toID(battle.p2);

    // If we are tracking users and a player in the game is one of them, report the battle
    if (this.users.size && (this.users.has(p1) || this.users.has(p2))) {
      return true;
    }

    // If a player has an our prefix, report if the battle is above the required rating
    if (p1.startsWith(this.prefix) || p2.startsWith(this.prefix)) {
      return rating >= this.rating;
    }

    // Report if a cutoff has been set and both prefixed players are within a factor of the cutoff
    if (this.config.cutoff && p1.startsWith(this.prefix) && p2.startsWith(this.prefix)) {
      const a = this.leaderboard.lookup.get(p1);
      const b = this.leaderboard.lookup.get(p2);
      const rank = this.config.cutoff * FACTOR;
      return a && a.rank && a.rank <= rank && b && b.rank && b.rank <= rank;
    }

    return false;
  }

  leaderboardCooldown(now: Date) {
    if (!this.cooldown) return true;
    const wait = Math.floor(+now - +this.cooldown / MINUTE);
    const lines = this.changed ? this.lines.them : this.lines.total;
    if (lines < 10 && wait < 5) return false;
    const factor = this.changed ? 6 : 1;
    return factor * (wait + lines) >= 60;
  }

  getDeadline(now: Date) {
    if (!this.deadline) {
      this.report('No deadline has been set.');
    } else {
      this.report(`**Time Remaining:** ${formatTimeRemaining(+this.deadline - +now, true)}`);
    }
  }
  onChat(parts: string[]) {
    const user = parts[3];
    if (toID(user) !== toID(this.config.nickname)) this.lines.them++;
    this.lines.total++;
    const message = parts.slice(4).join('|');
    const authed = AUTH.has(user.charAt(0)) || toID(user) === 'pre';
    const voiced = '+' === user.charAt(0);
    if (message.charAt(0) === TOKEN && (authed || voiced)) {
      console.info(`[${HHMMSS()}] ${user}: ${message.trim()}`);

      const parts = message.substring(1).split(' ');
      const command = toID(parts[0]);
      const argument = parts
        .slice(1)
        .join(' ')
        .toLowerCase()
        .trim();

      if (voiced) {
        const now = new Date();
        if (['leaderboard', 'top'].includes(command)) {
          if (this.leaderboardCooldown(now)) {
            this.cooldown = now;
            this.getLeaderboard(true);
          } else {
            const c = '``.' + command + '``';
            this.report(`${c} has been used too recently given activity, please try again later.`);
          }
        } else if (['remaining', 'deadline'].includes(command)) {
          this.getDeadline(now);
        }
        return;
      }

      switch (command) {
        case 'prefix':
          const prefix = toID(argument);
          if (prefix && prefix !== this.prefix) {
            this.prefix = prefix;
            this.leaderboard.current = undefined;
            this.leaderboard.last = undefined;
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
        case 'top':
        case 'leaderboard':
          this.getLeaderboard(true);
          return;
        case 'showdiffs':
        case 'startdiffs':
        case 'unhidediffs':
          this.showdiffs = true;
          return;
        case 'unshowdiffs':
        case 'stopdiffs':
        case 'hidediffs':
          this.showdiffs = false;
          return;
        case 'remaining':
        case 'deadline':
          if (argument) this.setDeadline(argument);
          this.getDeadline(new Date());
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
      const plural = this.users.size === 1 ? 'user' : 'users';
      this.report(`Currently tracking **${this.users.size}** ${plural}: ${users}`);
    }
  }

  async getLeaderboard(display?: boolean) {
    const url = `https://pokemonshowdown.com//ladder/${this.format}.json`;
    const leaderboard: LeaderboardEntry[] = [];
    try {
      const response = await http.get(url);
      this.leaderboard.lookup = new Map();
      for (const data of response.data.toplist) {
        // TODO: move the rounding until later
        const entry: LeaderboardEntry = {
          name: data.username,
          elo: Math.round(data.elo),
          gxe: data.gxe,
          glicko: Math.round(data.rpr),
          glickodev: Math.round(data.rprd),
        };
        this.leaderboard.lookup.set(data.userid, entry);
        if (!data.userid.startsWith(this.prefix)) continue;
        entry.rank = leaderboard.length + 1;
        leaderboard.push(entry);
      }
      if (display) {
        this.report(`/addhtmlbox ${this.styleLeaderboard(leaderboard)}`);
        this.leaderboard.last = leaderboard;
        this.changed = false;
        this.lines = { them: 0, total: 0 };
      }
    } catch (err) {
      console.error(err);
      if (display) this.report(`Unable to fetch the leaderboard for ${this.prefix}.`);
    }

    return leaderboard;
  }

  styleLeaderboard(leaderboard: LeaderboardEntry[], final?: number) {
    const diffs =
      this.leaderboard.last && !final
        ? this.getDiffs(this.leaderboard.last, leaderboard)
        : new Map();
    let buf = '<center>';
    if (final) {
      buf +=
        `<h1 style="margin-bottom: 0.2em">Final Leaderboard - ${this.prefix}</h1>` +
        `<div style="margin-bottom: 1em"><small><em>${final}</em></small></div>`;
    }
    buf +=
      '<div class="ladder" style="max-height: 250px; overflow-y: auto"><table>' +
      '<tr><th></th><th>Name</th><th><abbr title="Elo rating">Elo</abbr></th>' +
      '<th><abbr title="user\'s percentage chance of winning a random battle (aka GLIXARE)">GXE</abbr></th>' +
      '<th><abbr title="Glicko-1 rating system: rating±deviation (provisional if deviation>100)">Glicko-1</abbr></th></tr>';
    for (const [i, p] of leaderboard.entries()) {
      const id = toID(p.name);
      const { h, s, l } = hsl(id);
      const link = `https://www.smogon.com/forums/search/1/?q="${encodeURIComponent(p.name)}"`;
      const diff = diffs.get(id);
      let rank = `${i + 1}`;
      if (diff) {
        const symbol =
          diff[2] < diff[3]
            ? '<span style="color: #F00">▼</span>'
            : '<span style="color: #008000">▲</span>';
        rank = `${symbol}${rank}`;
      }
      buf +=
        `<tr><td style="text-align: right"><a href='${link}' class="subtle">${rank}</a></td>` +
        `<td><strong class="username" style="color: hsl(${h},${s}%,${l}%)">${p.name}</strong></td>` +
        `<td><strong>${p.elo}</strong></td><td>${p.gxe.toFixed(1)}%</td>` +
        `<td>${p.glicko} ± ${p.glickodev}</td></tr>`;
    }
    buf += '</table></div></center>';
    return buf;
  }

  getDiffs(last: LeaderboardEntry[], current: LeaderboardEntry[], num?: number) {
    const diffs: Map<ID, [string, number, number, number]> = new Map();

    const lastN = num ? last.slice(0, num) : last;
    for (const [i, player] of lastN.entries()) {
      const id = toID(player.name);
      const oldrank = i + 1;
      let newrank = current.findIndex(e => toID(e.name) === id) + 1;
      let elo: number;
      if (!newrank) {
        newrank = Infinity;
        elo = 0;
      } else {
        elo = current[newrank - 1].elo;
      }
      if (oldrank !== newrank) diffs.set(id, [player.name, elo, oldrank, newrank]);
    }

    const currentN = num ? current.slice(0, num) : current;
    for (const [i, player] of currentN.entries()) {
      const id = toID(player.name);
      const newrank = i + 1;
      let oldrank = last.findIndex(e => toID(e.name) === id) + 1;
      if (!oldrank) oldrank = Infinity;
      if (oldrank !== newrank) diffs.set(id, [player.name, player.elo, oldrank, newrank]);
    }

    return diffs;
  }

  trackChanges(leaderboard: LeaderboardEntry[], display?: boolean) {
    if (!this.leaderboard.current || !this.config.cutoff) return;
    const n = this.config.cutoff;
    const diffs = this.getDiffs(this.leaderboard.current, leaderboard, n * FACTOR);
    if (!diffs.size) return;

    const sorted = Array.from(diffs.values()).sort((a, b) => a[3] - b[3]);
    const messages = [];
    for (const [name, elo, oldrank, newrank] of sorted) {
      if (!((oldrank > n && newrank <= n) || (oldrank <= n && newrank > n))) {
        this.changed = true;
      }

      if (display) {
        const symbol = oldrank < newrank ? '▼' : '▲';
        const rank = newrank === Infinity ? '?' : newrank;
        const rating = elo || '?';
        const message = newrank > n ? `__${name} (${rating})__` : `${name} (${rating})`;
        messages.push(`${symbol}**${rank}.** ${message}`);
      }
    }

    if (display) this.report(messages.join(' '));
  }

  start() {
    if (this.started) return;

    this.report(`/status ${this.rating}`);
    this.started = setInterval(async () => {
      // Battles
      const filter = this.rating && !this.users.size ? `, ${this.rating}` : '';
      this.report(`/cmd roomlist ${this.format}${filter}`);

      // Leaderboard
      const leaderboard = await this.getLeaderboard();
      if (!leaderboard.length) return;
      if (this.leaderboard) this.trackChanges(leaderboard, this.showdiffs);
      this.leaderboard.current = leaderboard;
    }, INTERVAL);
  }

  stop() {
    if (this.started) {
      clearInterval(this.started);
      this.started = undefined;
      this.report(`/status (STOPPED) ${this.rating}`);
      this.leaderboard.current = undefined;
      this.leaderboard.last = undefined;
    }
  }

  report(message: string) {
    this.queue = this.queue.then(() => {
      this.connection!.send(`${this.loggedin ? this.config.room : ''}|${message}`.replace(/\n/g, ''));
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

function formatTimeRemaining(ms: number, round?: boolean): string {
  let s = ms / 1000;
  let h = Math.floor(s / 3600);
  let m = Math.floor((s - h * 3600) / 60);
  s = s - h * 3600 - m * 60;

  if (round) {
    s = Math.round(s);
    if (s === 60) {
      s = 0;
      m++;
    }
    if (m === 60) {
      m = 0;
      h++;
    }
  }

  const time = [];
  if (h > 0) time.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m > 0) time.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s > 0) time.push(`${s} second${s === 1 ? '' : 's'}`);
  return time.join(' ');
}

new Client(JSON.parse(fs.readFileSync(path.resolve(ROOT, process.argv[2]), 'utf8'))).connect();
