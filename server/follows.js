// What a member chose to follow, beyond what they can see: a topic (today
// 'members', the member applications board) tells them about new things on
// their own channels and counts on their home page; the rest stays quiet,
// however much they can open. A form's followers are kept with the form
// (server/forms/forms.js, notifyMeOf).

const db = require('./db');

async function isFollowing(userId, topic) {
  const { rows } = await db.query('select 1 from app_follows where user_id = $1 and topic = $2', [
    userId,
    topic,
  ]);
  return rows.length > 0;
}

async function setFollowing(userId, topic, on) {
  if (on) {
    await db.query(
      'insert into app_follows (user_id, topic) values ($1, $2) on conflict do nothing',
      [userId, topic]
    );
  } else {
    await db.query('delete from app_follows where user_id = $1 and topic = $2', [userId, topic]);
  }
  return Boolean(on);
}

/** The ids of the users following a topic. */
async function followers(topic) {
  const { rows } = await db.query('select user_id from app_follows where topic = $1', [topic]);
  return rows.map((r) => r.user_id);
}

module.exports = { isFollowing, setFollowing, followers };
