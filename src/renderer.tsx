import React from 'react';
import CronPanel from './CronPanel';

const STYLE_ID = 'local-cron-styles';

// tsc has no SCSS pipeline, so the panel styles are injected directly.
const injectStyles = () => {
	if (document.getElementById(STYLE_ID)) {
		return;
	}
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
		.LocalCron_Pane { padding: 20px 25px; overflow-y: auto; height: 100%; box-sizing: border-box; }
		.LocalCron_Pane code { font-family: monospace; font-size: 12px; }
		.LocalCron_Notice { background: #fdf6e3; border: 1px solid #e8d9a0; border-radius: 4px; padding: 10px 14px; margin-bottom: 14px; }
		.LocalCron_Row { display: flex; align-items: center; gap: 16px; margin-top: 14px; }
		.LocalCron_Label { width: 90px; flex: none; font-weight: 600; }
		.LocalCron_Control { flex: 1; max-width: 320px; }
		.LocalCron_LogControls { display: flex; align-items: center; gap: 14px; max-width: none; }
		.LocalCron_Help { margin: 6px 0 0 106px; font-size: 12px; color: #7f8285; line-height: 1.5; word-break: break-word; }
		.LocalCron_Crontab { display: block; width: 100%; box-sizing: border-box; margin-top: 14px; padding: 10px;
			font-family: monospace; font-size: 12px; line-height: 1.5; border: 1px solid #d5d7d8; border-radius: 4px; resize: vertical; }
		.LocalCron_Buttons { display: flex; align-items: center; gap: 14px; margin-top: 10px; }
		.LocalCron_Error { color: #d0021b; font-size: 12px; margin-top: 6px; }
		.LocalCron_Entries { width: 100%; margin-top: 12px; border-collapse: collapse; font-size: 12px; }
		.LocalCron_Entries td { padding: 4px 8px 4px 0; border-top: 1px solid #ebeced; vertical-align: middle; }
		.LocalCron_Command { width: 100%; word-break: break-all; }
		.LocalCron_Next { white-space: nowrap; color: #7f8285; }
		.LocalCron_Status { margin-top: 18px; padding: 10px 14px; background: #f6f7f8; border-radius: 4px; }
		.LocalCron_StatusRow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; }
		.LocalCron_Summary { font-family: monospace; font-size: 11px; color: #7f8285; margin-top: 2px; word-break: break-word; }
		.LocalCron_Ok { color: #3fa66b; }
		.LocalCron_Fail { color: #d0021b; }
		.LocalCron_Log { margin-top: 12px; max-height: 320px; overflow: auto; padding: 10px; background: #262728; color: #e6e6e6;
			font-family: monospace; font-size: 11px; line-height: 1.5; border-radius: 4px; white-space: pre-wrap; word-break: break-all; }
	`;
	document.head.appendChild(style);
};

export default function (context): void {
	const { hooks } = context;

	injectStyles();

	// A per-site Tools panel.
	hooks.addFilter('siteInfoToolsItem', (items: any[], extra: any) => {
		const site = extra?.routeChildrenProps?.site;
		if (!site) {
			return items;
		}
		return [
			...items,
			{
				path: '/localCron',
				menuItem: 'Cron',
				render: () => <CronPanel site={site} />,
			},
		];
	});
}
