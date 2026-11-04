// A stand-in Discord server for local development (MEET_DEV_DISCORD=1 with
// `npm run dev:meet`): the bot's calls the members board makes — listing and
// searching the server, reading someone, giving and taking roles, the roles'
// names — answered from memory, with invented people, so the Discord tab can
// be tried without a bot. Role changes stick until the server restarts.
// Never loaded on Vercel (scripts/meet-dev.js is local only).

const db = require('../server/db');
const permissions = require('../server/permissions');

const GUILD = '900000000000000000';
const ROLES = {
  participant: '100000000000000001',
  organizer: '100000000000000002',
};

function install() {
  process.env.DISCORD_BOT_TOKEN_AIS_TEAM_AREA ||= 'dev-bot';
  process.env.DISCORD_GUILD_ID ||= GUILD;
  process.env.DISCORD_ROLE_PARTICIPANT ||= ROLES.participant;
  process.env.DISCORD_ROLE_ORGANIZER ||= ROLES.organizer;

  // The working groups' roles, as seeded in server/schema.js.
  const G = {
    mentorship: '1566885628547960922',
    seminars: '1566885852347633766',
    technical: '1566885921062658079',
    community: '1566887710659051550',
    events: '1566887735308845169',
  };
  let next = 800000100;
  const person = (username, nick, roles, globalName) => ({
    id: `800000000${next++}`,
    username,
    nick: nick || null,
    globalName: globalName || null,
    roles,
    joinedAt: '2026-03-1' + (next % 10) + 'T10:00:00.000Z',
  });
  const people = [
    person('ada.uno', 'Ada Uno', [ROLES.participant, G.mentorship, G.events]),
    person('bea_due', null, [ROLES.participant], 'Bea Due'),
    person('ciro3', 'Ciro Tre', [ROLES.organizer, G.technical]),
    person('dora.q', 'Dora Quattro', [ROLES.participant, G.community]),
    person('elio5', 'Elio Cinque', []),
    person('fede.sei', 'Fede Sei', [G.seminars]),
    person('gaia7', 'Gaia Sette', [ROLES.participant]),
    person('guest.bot.owner', 'Lio', []),
  ];
  const names = {
    [ROLES.participant]: 'Partecipanti',
    [ROLES.organizer]: 'Organizzatori',
    [G.mentorship]: 'Mentorship',
    [G.seminars]: 'Seminari',
    [G.technical]: 'Tecnico',
    [G.community]: 'Community & networking',
    [G.events]: 'Eventi',
  };

  const asMember = (p) => ({
    user: { id: p.id, username: p.username, global_name: p.globalName, avatar: null },
    nick: p.nick,
    roles: p.roles,
    joined_at: p.joinedAt,
  });
  const reply = (body, status = 200) => ({
    ok: status < 300,
    status,
    json: async () => body,
  });

  permissions.setFetch(async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace(/^https:\/\/discord\.com\/api\/v10/, '');
    if (path === `/guilds/${GUILD}/roles`)
      return reply(
        Object.entries(names)
          .map(([id, name]) => ({ id, name }))
          // The sign-in stand-ins' roles too, for Settings → Permissions.
          .concat(permissions.DEV_ROLES.map((r) => ({ id: r.id, name: r.name })))
      );
    const search = /\/members\/search\?limit=\d+&query=([^&]*)/.exec(path);
    if (search) {
      const q = decodeURIComponent(search[1]).toLowerCase();
      return reply(
        people
          .filter((p) =>
            [p.username, p.nick || '', p.globalName || ''].some((n) =>
              n.toLowerCase().startsWith(q)
            )
          )
          .map(asMember)
      );
    }
    if (/\/members\?limit=1000/.test(path)) {
      const after = /after=(\d+)/.exec(path);
      return reply(people.filter((p) => !after || p.id > after[1]).map(asMember));
    }
    const role = /\/members\/(\d+)\/roles\/(\d+)$/.exec(path);
    if (role) {
      const p = people.find((x) => x.id === role[1]);
      if (!p) return reply({ message: 'Unknown Member' }, 404);
      if (method === 'PUT' && !p.roles.includes(role[2])) p.roles.push(role[2]);
      if (method === 'DELETE') p.roles = p.roles.filter((r) => r !== role[2]);
      console.log(
        `[dev Discord] ${method === 'PUT' ? 'gave' : 'took'} ${names[role[2]] || role[2]} ${
          method === 'PUT' ? 'to' : 'from'
        } ${p.username}`
      );
      return reply({}, 204);
    }
    const one = /\/members\/([\w-]+)$/.exec(path);
    if (one) {
      const p = people.find((x) => x.id === one[1]);
      if (p) return reply(asMember(p));
      // Someone signed in with the local stand-in: their roles as stored.
      const { rows } = await db.query('select roles from app_users where discord_id = $1', [
        one[1],
      ]);
      return rows[0]
        ? reply({ user: { id: one[1] }, roles: rows[0].roles || [] })
        : reply({ message: 'Unknown Member' }, 404);
    }
    return reply({}, 204);
  });
  console.log(
    `Discord: a stand-in server with ${people.length} invented people (MEET_DEV_DISCORD)`
  );
}

module.exports = { install };
