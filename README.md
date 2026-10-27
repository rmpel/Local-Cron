# Cron — Per-site cron, run by Local itself.

A [Local](https://localwp.com) addon (Local 9+) that gives every site a **Cron** panel under
**Tools**. Local itself runs the jobs, so you don't need system cron, launchd or a browser tab
left open. Jobs only run while the site is running.

## LICENSING

Copyright (C) 2026 Remon Pel.

This software is released under the GNU General Public License v3.0 (or, at
your option, any later version). The full license text is in the [LICENSE](LICENSE)
file that ships with every copy.

This means:

- You can use it however you like for both personal and business projects.
- If you modify and distribute your own version, you must share your source code under this exact same license.
- You cannot strip my name or copyright notice; proper attribution must always remain.
- While the license technically allows distribution, any copies must remain fully open-source, ensuring it stays free for everyone forever.

## Changelog

Can be found in [CHANGELOG.md](CHANGELOG.md)

## Co-authored by Claude, Opus 5.5

This project is written by myself and Claude, Opus 5.5, and tested by myself on local hardware in LocalWP 10. The API in v9 is identical, so it should work, but please feel free to either confirm or deny this claim.

## NO LIABILITY!!!!

Use at your own risk!!!!

Just because it works for me, does not mean it will work for you!

Feel free to burn it down!

I welcome every comment, positive as well as negative. (I might get cranky, but eventually I'll cave and fix it)

Feel free to contribute!

## How it works

Pick a mode in the site's **Tools → Cron** panel:

| Mode | What Local does |
|---|---|
| **Disabled** | Nothing. This is the default. |
| **Web** | Requests `wp-cron.php` on the site every *interval* minutes, following redirects and accepting Local's self-signed certificates. On a multisite it only covers the main site. |
| **CLI** | Runs `wp cron event run --due-now` every *interval* minutes with the site's own PHP, MySQL and WP-CLI. On a multisite it runs once for every (sub)site. |
| **Custom** | Runs your crontab. |

- **Interval** (web and cli): 1, 2, 5, 10, 15, 30 or 60 minutes. A run happens on the first minute tick after
  you switch the mode or the interval, and on the first tick after the site starts.
- **Locking** (web and cli): only one run per site at a time. If a run is still going when the
  next one is due, the new run is skipped (and logged as `SKIP`). Web and CLI runs are killed after 10 minutes.
- **Stopped sites**: nothing runs while a site is stopped. Stopping a site kills its running cron
  jobs and aborts web requests that are still in flight. Quitting Local does the same for every site.
- **Run now**: runs the web/cli job straight away (the lock still applies). In custom mode each line has its own **Run** button.

Tip: with web or cli mode, add `define( 'DISABLE_WP_CRON', true );` to `wp-config.php` so page loads
stop triggering cron as well. Requesting `wp-cron.php` directly still works with that constant set.

### Custom crontab

Standard five-field crontab lines: `minute hour day-of-month month day-of-week command`.

- `*`, lists (`1,15`), ranges (`9-17`), steps (`*/5`, `9-17/2`, `5/20`), month and weekday names (`jan`, `mon-fri`), and `7` for Sunday.
- When both day-of-month and day-of-week are restricted, either one may match (classic cron behaviour).
- Macros: `@hourly`, `@daily`/`@midnight`, `@weekly`, `@monthly`, `@yearly`/`@annually`, and
  `@reboot`, which runs when the site starts.
- `NAME=value` lines set environment variables for the commands below them. `$NAME` / `${NAME}`
  are expanded, so `PATH=/opt/homebrew/bin:$PATH` works.
- `#` comments and blank lines are ignored.

Commands run through `/bin/sh` in the site's web root with the environment of Local's
**Open site shell**: the site's `php`, `mysql`, `wp` and `composer` come first on `PATH`, and `PHPRC`,
`MYSQL_HOME` and `WP_CLI_CONFIG_PATH` are set. Local is a GUI app, so the rest of `PATH` is
the bare system one. Use absolute paths or a `PATH=` line for tools from Homebrew and similar.

The web root is the `DocumentRoot` from the site's `conf/apache/site.conf.hbs` (or the `root` from
`conf/nginx/site.conf.hbs`). This is usually `app/public`, but composer-based sites or custom configs often use
something else, such as `app/public_html`. If the config still holds Local's `{{root}}` placeholder, Local's
own `app/public` is used. The panel shows the directory, and the default crontab names it in its first comment.

Custom commands have no lock and no time limit, the same as system cron. They are still killed when the site stops.

The panel checks the crontab as you type, shows the next run time for every line, and won't
save a crontab that has errors.

### Logging

Turn on **Logging** to write every run to `<site>/logs/cron/cron.log`. Each run gets one line
with the result and duration, followed by its output, indented. Once the log passes 1 MB it rotates to `cron.log.1`.
**View log** shows the tail of the log inside the panel and follows it while the panel is open.
**Reveal in Finder**, **Open** and **Clear** do what they say.

Failed runs are always noted in Local's own log, whether or not logging is on.

### Storage

The settings live on the site record (`localCron` in Local's `sites.json`) via `siteData.updateSite()`,
so they survive restarts. The last-run status is kept in memory only.

## Installing;

- Clone repo
- Shut down LocalWP
- run ./scripts/install.sh
- Start LocalWP
- Enable Plugin
- Restart LocalWP when so asked

## Compatibility

- `engines.local-by-flywheel: >=9.0.0`. Built against the Local 9 addon API
  (`@getflywheel/local@9`) and the hook/service surface of Local 10.
- Custom commands use `/bin/sh` on macOS/Linux. On Windows they run through `cmd`, which has had less testing.
