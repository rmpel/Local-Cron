import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Site } from '@getflywheel/local';
import { ipcAsync } from '@getflywheel/local/renderer';
import { FlySelect, PrimaryButton, Switch, TextButton } from '@getflywheel/local-components';
import { CronMode, CronSettings, CronState, INTERVALS, IPC_EVENTS, MODE_LABELS } from './constants';
import { nextRun, parseCrontab } from './crontab';

interface Props {
	site: Site;
}

/** Status refresh while the panel is open. */
const POLL_MS = 3000;

const MODE_HELP: Record<CronMode, React.ReactNode> = {
	disabled: <>Local does not run cron for this site. WordPress still runs its own cron on page loads unless <code>DISABLE_WP_CRON</code> is set.</>,
	web: <>Local requests <code>wp-cron.php</code> on the site, like a visitor would. Only the main site of a multisite is covered.</>,
	cli: <>Local runs <code>wp cron event run --due-now</code> with the site's PHP; on multisite once for every site.</>,
	custom: <>
		Crontab lines (<code>m h dom mon dow command</code>), run in the site's web root (shown below) with the site shell environment:
		<code>php</code>, <code>wp</code>, <code>mysql</code> and <code>composer</code> are on PATH.
		Also supported: <code>@hourly</code>, <code>@daily</code>, <code>@weekly</code>, <code>@monthly</code>, <code>@yearly</code>,
		<code>@reboot</code> (= when the site starts) and <code>NAME=value</code> lines. Custom commands are not locked and never time out.
	</>,
};

const formatTime = (ms: number): string => new Date(ms).toLocaleString(undefined, {
	weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const formatSize = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

const CronPanel = ({ site }: Props) => {
	const [state, setState] = useState<CronState | null>(null);
	const [draft, setDraft] = useState('');
	const [logText, setLogText] = useState<string | null>(null);
	const [logOpen, setLogOpen] = useState(false);
	const logRef = useRef<HTMLPreElement>(null);

	const refresh = useCallback(async () => {
		const next: CronState = await ipcAsync(IPC_EVENTS.GET_STATE, site.id);
		setState(next);
		return next;
	}, [site.id]);

	useEffect(() => {
		setState(null);
		setLogOpen(false);
		setLogText(null);
		refresh().then((next) => setDraft(next?.settings.crontab ?? ''));
		const timer = setInterval(refresh, POLL_MS);
		return () => clearInterval(timer);
	}, [site.id]);

	const loadLog = useCallback(async () => {
		setLogText(await ipcAsync(IPC_EVENTS.READ_LOG, site.id));
	}, [site.id]);

	// Follow the log while the viewer is open.
	useEffect(() => {
		if (logOpen) {
			loadLog();
		}
	}, [logOpen, state?.logSize]);

	useEffect(() => {
		if (logRef.current) {
			logRef.current.scrollTop = logRef.current.scrollHeight;
		}
	}, [logText]);

	const parsed = useMemo(() => parseCrontab(draft), [draft]);

	if (state === null) {
		return <div className="LocalCron_Pane">Loading…</div>;
	}

	const { settings } = state;
	const save = async (patch: Partial<CronSettings>) => setState(await ipcAsync(IPC_EVENTS.SAVE_SETTINGS, site.id, patch));
	const runNow = async (line?: number) => setState(await ipcAsync(IPC_EVENTS.RUN_NOW, site.id, line));
	const dirty = draft !== settings.crontab;
	const scheduled = settings.mode === 'web' || settings.mode === 'cli';

	return (
		<div className="LocalCron_Pane">
			{!state.siteRunning && settings.mode !== 'disabled' && (
				<div className="LocalCron_Notice">The site is stopped, so cron is paused. It resumes when the site starts.</div>
			)}

			<div className="LocalCron_Row">
				<label className="LocalCron_Label">Cron</label>
				<div className="LocalCron_Control">
					<FlySelect
						value={settings.mode}
						options={MODE_LABELS}
						onChange={(mode: CronMode) => save({ mode })}
					/>
				</div>
			</div>
			<p className="LocalCron_Help">{MODE_HELP[settings.mode]}</p>
			{settings.mode === 'custom' && (
				<p className="LocalCron_Help">
					Commands run in <strong>{state.webRoot.split(/[\\/]/).pop()}</strong>: <code>{state.webRoot}</code>
				</p>
			)}

			{scheduled && (
				<div className="LocalCron_Row">
					<label className="LocalCron_Label">Interval</label>
					<div className="LocalCron_Control">
						<FlySelect
							value={String(settings.interval)}
							options={Object.fromEntries(INTERVALS.map((minutes) => [
								String(minutes),
								minutes === 1 ? 'Every minute' : minutes === 60 ? 'Every hour' : `Every ${minutes} minutes`,
							]))}
							onChange={(interval: string) => save({ interval: Number(interval) })}
						/>
					</div>
				</div>
			)}

			{settings.mode === 'custom' && (
				<>
					<textarea
						className="LocalCron_Crontab"
						value={draft}
						spellCheck={false}
						rows={Math.max(6, draft.split('\n').length + 1)}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<div className="LocalCron_Buttons">
						<PrimaryButton
							disabled={!dirty || parsed.errors.length > 0}
							onClick={() => save({ crontab: draft })}
						>
							Save crontab
						</PrimaryButton>
						{dirty && <TextButton onClick={() => setDraft(settings.crontab)}>Revert</TextButton>}
					</div>
					{parsed.errors.map((error) => (
						<div key={error.line} className="LocalCron_Error">Line {error.line}: {error.message}</div>
					))}
					{parsed.entries.length > 0 && (
						<table className="LocalCron_Entries">
							<tbody>
								{parsed.entries.map((entry) => {
									const next = nextRun(entry);
									return (
										<tr key={entry.line}>
											<td><code>{entry.schedule}</code></td>
											<td className="LocalCron_Command"><code>{entry.command}</code></td>
											<td className="LocalCron_Next">
												{entry.reboot ? 'when the site starts' : next ? formatTime(next.getTime()) : 'never'}
											</td>
											<td>
												<TextButton
													disabled={dirty || !state.siteRunning}
													onClick={() => runNow(entry.line)}
												>
													Run
												</TextButton>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					)}
				</>
			)}

			{settings.mode !== 'disabled' && (
				<div className="LocalCron_Status">
					{scheduled && (
						<div className="LocalCron_StatusRow">
							<span>
								{state.locked
									? 'Running now…'
									: state.nextRun
										? <>Next run: {formatTime(state.nextRun)}</>
										: 'No run scheduled while the site is stopped.'}
							</span>
							<PrimaryButton disabled={state.locked || !state.siteRunning} onClick={() => runNow()}>
								Run now
							</PrimaryButton>
						</div>
					)}
					{settings.mode === 'custom' && state.runningCustom > 0 && (
						<div className="LocalCron_StatusRow">{state.runningCustom} command(s) running…</div>
					)}
					<div className="LocalCron_StatusRow">
						{state.lastRun ? (
							<span>
								Last run: {formatTime(state.lastRun.at)} —{' '}
								<strong className={state.lastRun.ok ? 'LocalCron_Ok' : 'LocalCron_Fail'}>
									{state.lastRun.ok ? 'OK' : 'failed'}
								</strong>{' '}
								in {(state.lastRun.durationMs / 1000).toFixed(1)}s
								{settings.mode === 'custom' && <> (<code>{state.lastRun.label}</code>)</>}
								<div className="LocalCron_Summary">{state.lastRun.summary}</div>
							</span>
						) : (
							<span>No runs since Local started.</span>
						)}
					</div>
				</div>
			)}

			<div className="LocalCron_Row">
				<label className="LocalCron_Label">Logging</label>
				<div className="LocalCron_Control LocalCron_LogControls">
					<Switch flat tiny name="localCronLogging" checked={settings.logging} onChange={(_: unknown, logging: boolean) => save({ logging })} />
					<TextButton onClick={() => setLogOpen(!logOpen)}>{logOpen ? 'Hide log' : 'View log'}</TextButton>
					<TextButton onClick={() => ipcAsync(IPC_EVENTS.REVEAL_LOG, site.id)}>Reveal in Finder</TextButton>
					<TextButton disabled={state.logSize === null} onClick={() => ipcAsync(IPC_EVENTS.OPEN_LOG, site.id)}>Open</TextButton>
					<TextButton
						disabled={state.logSize === null}
						onClick={async () => {
							setState(await ipcAsync(IPC_EVENTS.CLEAR_LOG, site.id));
							setLogText(null);
						}}
					>
						Clear
					</TextButton>
				</div>
			</div>
			<p className="LocalCron_Help">
				<code>{state.logPath}</code>
				{state.logSize !== null && <> — {formatSize(state.logSize)}</>}
				{' '}Rotates to <code>cron.log.1</code> at 1 MB. Failures are always noted in Local's own log.
			</p>

			{logOpen && (
				<pre className="LocalCron_Log" ref={logRef}>
					{logText ?? (settings.logging ? 'The log is empty.' : 'Logging is off, so there is no log yet.')}
				</pre>
			)}
		</div>
	);
};

export default CronPanel;
