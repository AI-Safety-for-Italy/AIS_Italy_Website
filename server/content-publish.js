// What happens after a seminar or event is saved from the dashboard:
//   1. the site is rebuilt, so the change goes live (about 3 minutes);
//   2. the team's Discord channel is told who published what.
// Neither ever makes the save fail: the item is already in the database, and
// the next build picks it up anyway. Each returns what happened, for the page.
//
// Env:
//   CONTENT_BUILD_TOKEN        GitHub token allowed to run workflows on this
//                              repository (fine-grained, "Actions: write" only)
//   CONTENT_BUILD_REF          branch to rebuild: main in production, dev on
//                              the preview deployments (default main)
//   CONTENT_BUILD_REPO         default AI-Safety-for-Italy/AIS_Italy_Website
//   DISCORD_CONTENT_CHANNEL_ID channel for the announcements
//   DISCORD_BOT_TOKEN_AIS_TEAM_AREA  the bot that posts them
// Locally (MEET_DEV_LOGIN=1, no token) the build is the watching Eleventy:
// the published items are written to _content-snapshot.json, and the
// announcement is printed in the terminal.

const contentBuild = require('./content-build');
const content = require('./content');

const DISCORD_API = 'https://discord.com/api/v10';

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) {
  fetchImpl = fn;
}

function isLocal() {
  return process.env.MEET_DEV_LOGIN === '1' && !process.env.CONTENT_BUILD_TOKEN;
}

/** Starts the deploy workflow. Returns { started, detail }. */
async function triggerBuild() {
  if (isLocal()) {
    contentBuild.writeSnapshot(await content.exportForBuild());
    return { started: true, detail: 'local: snapshot written, Eleventy rebuilds' };
  }
  const token = process.env.CONTENT_BUILD_TOKEN;
  if (!token) return { started: false, detail: 'CONTENT_BUILD_TOKEN is not set' };
  const repo = process.env.CONTENT_BUILD_REPO || 'AI-Safety-for-Italy/AIS_Italy_Website';
  const ref = process.env.CONTENT_BUILD_REF || 'main';
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref }),
      }
    );
    if (res.status === 204) return { started: true, detail: `rebuilding ${ref}` };
    console.error('Starting the build failed', res.status, await res.text().catch(() => ''));
    return { started: false, detail: `GitHub answered ${res.status}` };
  } catch (err) {
    console.error('Starting the build failed', err.message);
    return { started: false, detail: err.message };
  }
}

const VERBS = {
  create: 'published',
  update: 'updated',
  delete: 'removed',
  restore: 'restored an earlier version of',
};
const KINDS = { seminar: 'the seminar', event: 'the event' };

function message({ user, action, entry, siteOrigin }) {
  const page = entry.category === 'event' ? '/events/' : '/seminars/';
  const where = action === 'delete' ? '' : `\n${siteOrigin}${page}#${entry.anchor}`;
  return `📝 ${user.name} ${VERBS[action] || action} ${KINDS[entry.category] || 'an item'} **${
    entry.title
  }** (${entry.date}).${where}\nOnline in a few minutes.`;
}

/** Posts in the team channel. Returns { sent, detail }. */
async function announce({ user, action, entry, siteOrigin }) {
  const text = message({ user, action, entry, siteOrigin });
  const channel = process.env.DISCORD_CONTENT_CHANNEL_ID;
  const token = process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA;
  if (!channel || !token) {
    if (process.env.MEET_DEV_LOGIN === '1') {
      console.log(`\n[Discord announcement]\n${text}\n`);
      return { sent: true, detail: 'local: printed in the terminal' };
    }
    return { sent: false, detail: 'no announcement channel set' };
  }
  try {
    const res = await fetchImpl(`${DISCORD_API}/channels/${channel}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
    });
    if (res.ok) return { sent: true };
    console.error('Discord announcement failed', res.status);
    return { sent: false, detail: `Discord answered ${res.status}` };
  } catch (err) {
    console.error('Discord announcement failed', err.message);
    return { sent: false, detail: err.message };
  }
}

/** Both steps after a save; returns { build, announcement }. */
async function afterSave({ user, result, siteOrigin }) {
  const build = await triggerBuild();
  const announcement = await announce({
    user,
    action: result.action,
    entry: result.entry,
    siteOrigin,
  });
  return { build, announcement };
}

module.exports = { setFetch, triggerBuild, announce, afterSave, message };
