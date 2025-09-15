const RELEASE_CACHE_KEY = 'latest-github-release-id';
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases?per_page=10';

interface GitHubRelease {
	id: number;
	tag_name: string;
	name: string | null;
	html_url: string;
	body: string | null;
	published_at: string | null;
	draft: boolean;
	prerelease: boolean;
}

const worker: ExportedHandler<Env> = {
	async fetch(req, env, ctx) {
		const url = new URL(req.url);
		if (url.pathname === '/trigger' && req.method === 'POST') {
			ctx.waitUntil(runMonitor(env));
			return new Response('monitoring run queued', { status: 202 });
		}

		return new Response('Codex CLI release monitor is active. POST /trigger to force a poll.', {
			headers: { 'content-type': 'text/plain; charset=utf-8' },
		});
	},

	async scheduled(_event, env, ctx) {
		ctx.waitUntil(runMonitor(env));
	},
};

async function runMonitor(env: Env) {
	try {
		const releases = await fetchLatestReleases();
		if (!releases.length) {
			console.log('No releases returned from GitHub.');
			return;
		}

		const cachedId = await env.RELEASE_CACHE.get(RELEASE_CACHE_KEY);
		if (!cachedId) {
			await env.RELEASE_CACHE.put(RELEASE_CACHE_KEY, releases[0].id.toString());
			console.log('Cache primed with release id', releases[0].id);
			return;
		}

		const newReleases = collectNewReleases(releases, cachedId);
		if (!newReleases.length) {
			console.log('No new releases detected.');
			return;
		}

		for (const release of newReleases.reverse()) {
			await notifyTelegram(env, release);
		}

		await env.RELEASE_CACHE.put(RELEASE_CACHE_KEY, releases[0].id.toString());
		console.log('Cache updated to release id', releases[0].id);
	} catch (error) {
		console.error('Release monitor run failed', error);
		throw error;
	}
}

async function fetchLatestReleases(): Promise<GitHubRelease[]> {
	const resp = await fetch(GITHUB_RELEASES_URL, {
		headers: {
			Accept: 'application/vnd.github+json',
			'User-Agent': 'codex-monitor-worker/1.0',
		},
	});

	if (!resp.ok) {
		const message = await safeText(resp);
		throw new Error(`GitHub releases request failed: ${resp.status} ${message}`);
	}

	const payload = (await resp.json()) as GitHubRelease[];
	return payload.filter((release) => !release.draft);
}

function collectNewReleases(releases: GitHubRelease[], cachedId: string): GitHubRelease[] {
	const upcoming: GitHubRelease[] = [];
	for (const release of releases) {
		if (release.id.toString() === cachedId) {
			break;
		}
		upcoming.push(release);
	}
	return upcoming;
}

async function notifyTelegram(env: Env, release: GitHubRelease) {
	const message = buildTelegramMessage(release);
	const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

	const body: Record<string, unknown> = {
		chat_id: env.TELEGRAM_CHAT_ID,
		text: message,
		disable_web_page_preview: true,
	};

	const threadId = parseThreadId(env.TELEGRAM_THREAD_ID);
	if (threadId) {
		body.message_thread_id = threadId;
	}

	const resp = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const messageText = await safeText(resp);
		throw new Error(`Telegram notification failed: ${resp.status} ${messageText}`);
	}

	console.log('Telegram notification sent for release', release.tag_name);
}

function parseThreadId(raw: string | undefined): number | undefined {
	if (!raw) {
		return undefined;
	}
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

function buildTelegramMessage(release: GitHubRelease): string {
	const published = release.published_at ? new Date(release.published_at).toUTCString() : 'Unknown date';
	const title = release.name?.trim() || release.tag_name;
	const header = release.prerelease ? `🚀 Codex CLI pre-release: ${title}` : `🚀 Codex CLI update: ${title}`;
	const summary = trimBody(release.body ?? '', 800);

	return [
		header,
		`Tag: ${release.tag_name}`,
		`Published: ${published}`,
		summary ? `\n${summary}` : undefined,
		`\nDetails: ${release.html_url}`,
	]
		.filter(Boolean)
		.join('\n');
}

function trimBody(body: string, limit: number): string {
	const normalized = body.replace(/\r\n/g, '\n').trim();
	if (!normalized) {
		return '';
	}
	if (normalized.length <= limit) {
		return normalized;
	}
	return `${normalized.slice(0, limit).trimEnd()}…`;
}

async function safeText(resp: Response): Promise<string> {
	try {
		return await resp.text();
	} catch (error) {
		console.warn('Failed to read response text', error);
		return '<no body>';
	}
}

export default worker;
