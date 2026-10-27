# Changelog for LocalWP Plugin "Local Cron"

= 1.0.0 =

- Released under GPLv3, see LICENSE for details.
- First release: per-site cron, run by Local itself, in a Tools → Cron panel.
- Modes: disabled, web (`wp-cron.php`), cli (`wp cron event run --due-now`, per subsite on multisite) and a custom crontab.
- Web/cli: interval of 1–60 minutes, a per-site lock so runs never overlap, a 10-minute run limit, and Run now.
- Custom: five-field crontab with names, ranges, steps, macros, `@reboot` (= when the site starts) and `NAME=value` lines; checked as you type, with the next run time per line.
- Commands run in the site's real document root, taken from the DocumentRoot (or nginx root) in the site's config, so composer sites with `public_html` work. The panel and the default crontab comment name that directory.
- Nothing runs while a site is stopped; stopping a site kills its running jobs.
- Optional log in `<site>/logs/cron/cron.log` (rotates at 1 MB), with a viewer, Reveal in Finder, Open and Clear in the panel.
