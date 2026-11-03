// Tests for the build's copy of the published mentors (server/mentors-build.js):
// merging into data/mentors.yaml, reading the live site and writing the photos.
// On invented data only. Run with `npm run test:meet`.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mentorsBuild = require('./mentors-build');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const yaml = {
  title: 'Mentors',
  mentors: [
    { id: 'anna-uno', name: 'Anna Uno' },
    { id: 'bruno-due', name: 'Bruno Due' },
    { id: 'carla-tre', name: 'Carla Tre' },
  ],
};

function answer(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    arrayBuffer: async () => body,
  };
}

afterEach(() => {
  delete process.env.CONTENT_SOURCE;
  mentorsBuild.setFetch((...args) => fetch(...args));
});

test('merge replaces in place, appends new ones, hides, and leaves the input alone', () => {
  const before = JSON.stringify(yaml);
  const published = {
    live: true,
    mentors: [
      { id: 'dario-quattro', name: 'Dario Quattro' },
      { id: 'bruno-due', name: 'Bruno Due (board)' },
      { id: 'elena-cinque', name: 'Elena Cinque' },
    ],
    hidden: ['carla-tre'],
  };
  const out = mentorsBuild.merge(yaml, published);
  assert.deepEqual(
    out.mentors.map((m) => m.id),
    ['anna-uno', 'bruno-due', 'dario-quattro', 'elena-cinque']
  );
  assert.equal(out.mentors[1].name, 'Bruno Due (board)');
  assert.equal(out.title, 'Mentors');
  assert.equal(JSON.stringify(yaml), before);
});

test('merge keeps the YAML when nothing is live', () => {
  assert.equal(mentorsBuild.merge(yaml, { live: false }), yaml);
});

test('load: a site without the mentors leaves the YAML, an error stops the build', async () => {
  process.env.CONTENT_SOURCE = 'https://example.org/';
  mentorsBuild.setFetch(async () => answer(404));
  assert.deepEqual(await mentorsBuild.load(), { live: false });
  mentorsBuild.setFetch(async () => answer(500));
  await assert.rejects(mentorsBuild.load(), /answered 500/);
});

test('load fetches the photos, and a failed photo stops the build', async () => {
  process.env.CONTENT_SOURCE = 'https://example.org';
  const mentors = [
    { id: 'anna-uno', name: 'Anna Uno', photo: '/assets/img/mentors/anna-uno-0123abcd.jpg' },
    { id: 'bruno-due', name: 'Bruno Due', photo: '/assets/img/mentors/../../../evil.jpg' },
  ];
  const urls = [];
  let photoStatus = 200;
  mentorsBuild.setFetch(async (url) => {
    urls.push(url);
    if (url.endsWith('part=mentors')) return answer(200, { live: true, mentors, hidden: [] });
    return answer(photoStatus, JPEG);
  });

  const data = await mentorsBuild.load();
  assert.deepEqual(urls, [
    'https://example.org/api/content?part=mentors',
    'https://example.org/api/content?part=mentor-photo&id=anna-uno',
  ]);
  assert.equal(data.photos['anna-uno'], JPEG.toString('base64'));
  assert.equal(data.mentors[1].photo, undefined, 'an unsafe path is dropped');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentors-'));
  mentorsBuild.writePhotos(data, dir);
  assert.deepEqual(fs.readdirSync(dir), ['anna-uno-0123abcd.jpg']);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'anna-uno-0123abcd.jpg')), JPEG);
  fs.rmSync(dir, { recursive: true });

  photoStatus = 404;
  await assert.rejects(mentorsBuild.load(), /answered 404/);
  photoStatus = 200;
  mentorsBuild.setFetch(async (url) =>
    url.endsWith('part=mentors')
      ? answer(200, { live: true, mentors, hidden: [] })
      : answer(200, Buffer.from('<html>'))
  );
  await assert.rejects(mentorsBuild.load(), /not a JPEG/);
});
