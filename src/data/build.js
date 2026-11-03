// Cache-busting token for /assets/css and /assets/js URLs (served immutable).
const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA;
module.exports = sha ? sha.slice(0, 8) : Date.now().toString(36);
