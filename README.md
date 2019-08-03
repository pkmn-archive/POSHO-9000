# LadderBot

A Pokémon Showdown bot which reports on battles taking place on the ladder which
match specific criteria.

## Usage

```sh
$ npm install
$ npm start # requires config.json to be set up
```

```json
{
  "server": "sim.smogon.com",
  "serverport": "8000",
  "serverid": "showdown",

  "nickname": "OLTBot",
  "password": "password",
  "room": "officialladdertournament",

  "format": "gen7ou",
  "prefix": "LT63RB",
  "rating": 1500
}
```

Alternatively, `npm run compile && node build/index`.

## Commands

The bot responds to any staff (`%` or higher) and understands the following
commands typed into chat:

| **command** | **description** | **aliases?** |
| ----------- | ----------------| -------------|
| `.format FORMAT`| changes the format (eg. 'gen7ou') from the default format specified in `config.json` | |
| `.prefix PREFIX` | changes the format (eg. 'LT63RB') from the default format specified in `config.json` | |
| `.rating RATING` | only report on battles with this rating or higher (minimum Elo of either player) | `.elo` |
| `.watch PLAYER, ...` | report on all battles for this player (or players, if multiple separated by commas are specified) regardless of rating | `.add`, `.track`, `.follow` |
| `.unwatch PLAYER, ...` | stop watching all battles from the player(s) specified (though they will still show if >= the rating) | `.remove`, `.untrack`, `.unfollow` |
| `.watched` | reports on which players are currently being 'watched' | `.list`, `.tracked`, `.followed` |
| `.leaderboard N` | displays the top N players on the leaderboard for the configured format and prefix | |
| `.showdiffs N` | starts reporting rises and drops within the top N players on the leaderboard for the configured format and prefix (negative value = only report movement around cutoff N) | `.unhidediffs`, `.startdiffs` |
| `.hidediffs`| stops reporting rises and drops | `.unshowdiffs`, `.stopdiffs` |
| `.start` | starts reporting on battles which match the configured criteria | |
| `.stop` | stops reporting any battles | |
| `.leave` | causes the bot to leave the room | |

The most common usecase is to use `.rating` to tweak which battles get reported
on (**NOTE:** a battle's rating is the *minimum* Elo of the two players
involved), but `.watch` can also be used to follow a player who hasn't crossed the
threshold yet. If you only care about watching players specified by `.watch`,
set `.rating 5000` or something similarly unattainable and only battles from
players in the `.watched` set will be reported on.

## Credits

This code is heavily based on Konrad Borowski's (xfix)
[PSDevBot](https://gitlab.com/KonradBorowski/PSDevBot).

## License

This code is distributed under the under the terms of the [MIT License][1].

[1]: https://github.com/pkmn-cc/LadderBot/blob/master/stats/LICENSE
