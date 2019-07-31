import 'source-map-support/register';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as querystring from 'querystring';
import * as ws from 'websocket';

const MINUTE = 60000;
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

const CHAT = new Set(['chat', 'c', 'c:']);
const AUTH = new Set('~&#@%');

class Client {
  private readonly config: Readonly<Config>;

  private connection: ws.connection | null;
  private queue: Promise<void>;

  private format: ID;
  private prefix?: ID;
  private rating?: number;
  private users: Set<ID>;

  private lastid?: string;
  private started?: NodeJS.Timeout;

  constructor(config: Config) {
    this.config = config;

    this.format = toID(this.config.format);
    this.prefix = toID(this.config.prefix);
    this.rating = this.config.rating;

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
    } else if (CHAT.has(parts[1])) {
      this.onChat(parts);
    }
  }

  onChallstr(parts: string[]) {
    const id = parts[2];
    const str = parts[3];

    const data = querystring.stringify({
      act: 'login',
      challengekeyid: id,
      challenge: str,
      name: this.config.nickname,
      pass: this.config.password,
    });

    const options = {
      hostname: 'play.pokemonshowdown.com',
      port: 443,
      path: `/~~${this.config.serverid}/action.php`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': data.length,
      },
    };

    let body = '';
    const req = https
      .request(options, resp => {
        resp.on('data', chunk => {
          body += chunk;
        });
        resp.on('end', () => {
          const result = JSON.parse(body.replace(/^]/, ''));
          this.report(`/trn ${this.config.nickname},0,${result.assertion}`);
          this.report('/join ' + this.config.room);
          this.report('/avatar oak-gen1rb');
        });
      })
      .on('error', err => {
        console.error(err);
        this.onChallstr(parts);
      });
    req.write(data);
    req.end();
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
    const { h, s, l } = hsl(player);
    return `<strong><font color="${hslToHex(h, s, l)}">${player}</font></strong>`;
  }

  tracking(battle: Battle) {
    // If prefix isn't set and there are no tracked users, don't report anything
    if (!this.prefix && !this.users.size) return false;

    const p1 = toID(battle.p1);
    const p2 = toID(battle.p2);

    // If we are tracking users and a player in the game is one of them, report the battle
    if (this.users.size && (this.users.has(p1) || this.users.has(p2))) {
      return true;
    }

    // If a player has an our prefix, report if the battle is above the required rating
    if (this.prefix && (p1.startsWith(this.prefix!) || p2.startsWith(this.prefix!))) {
      return !this.rating || battle.minElo >= this.rating;
    }

    return false;
  }

  onChat(parts: string[]) {
    const user = parts[3];
    const message = parts.slice(4).join('|');
    if (AUTH.has(user.charAt(0)) && message.charAt(0) === '.') {
      const parts = message.substring(1).split(' ');
      const command = toID(parts[0]);
      const argument = parts
        .slice(1)
        .join(' ')
        .toLowerCase()
        .trim();

      switch (command) {
        case 'format':
          const format = toID(argument);
          if (format) this.format = format;
          return;
        case 'prefix':
          this.prefix = toID(argument);
          return;
        case 'elo':
        case 'rating':
          const rating = Number(argument);
          if (rating) this.rating = rating;
          return;
        case 'add':
        case 'track':
        case 'watch':
        case 'follow':
          for (const user of argument.split(',')) {
            this.users.add(toID(user));
          }
          return;
        case 'remove':
        case 'untrack':
        case 'unwatch':
        case 'unfollow':
          for (const user of argument.split(',')) {
            this.users.delete(toID(user));
          }
          return;
        case 'list':
        case 'tracked':
        case 'tracking':
        case 'watched':
        case 'watching':
        case 'followed':
        case 'following':
          if (!this.users.size) {
            this.report(`Not currently tracking any users.`);
          } else {
            const users = Array.from(this.users.values()).join(', ');
            this.report(`Currently tracking ${this.users.size} users: ${users}`);
          }
          return;
        case 'start':
          this.started = setInterval(() => {
            const filter = this.rating && !this.users.size ? `, ${this.rating}` : '';
            this.report(`/cmd roomlist ${this.format}${filter}`);
          }, INTERVAL);
          return;
        case 'stop':
          if (this.started) {
            clearInterval(this.started);
            this.started = undefined;
          }
          return;
        case 'leave':
          this.report(`/leave`); // :(
          return;
      }
    }
  }

  report(message: string) {
    this.queue = this.queue.then(() => {
      this.connection!.send(`${this.config.room}|${message}`.replace(/\n/g, ''));
      return new Promise(resolve => {
        setTimeout(resolve, 500);
      });
    });
  }
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

function hslToHex(h: number, s: number, l: number) {
  h /= 360;
  s /= 100;
  l /= 100;
  let r, g, b;
  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (x: number) => {
    const hex = Math.round(x * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const client = new Client(JSON.parse(fs.readFileSync(path.resolve(ROOT, process.argv[2]), 'utf8')));
client.connect();
