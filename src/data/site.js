const { validateSiteData, logValidationErrors } = require('../utils/validation');

// Site configuration
const siteData = {
  description:
    "AI Safety for Italy is Italy's grassroots community reducing risks from advanced AI through awareness, education, and collaboration. Open to researchers, students, and professionals.",
  site: {
    name: 'AI Safety for Italy',
    description:
      "AI Safety for Italy is Italy's grassroots community reducing risks from advanced AI through awareness, education, and collaboration. Open to researchers, students, and professionals.",
    domain: 'www.ais4i.it',
    email: 'aisafetyitalia@gmail.com',
  },
  navigation: [
    { name: 'Home', url: '/' },
    { name: 'About', url: '/about/', dropdown: false },
    { name: 'Initiatives', url: '/initiatives/' },
    { name: 'Community', url: '/community/' },
    { name: 'FAQ', url: '/faq/' },
    { name: 'Contact', url: '/contact/' },
  ],
  social: {
    linkedin: 'https://www.linkedin.com/company/ai-safety-italia/',
    discord: 'https://discord.gg/aYNAPZjQJu',
  },
  forms: {
    mailingList: 'https://forms.gle/mtBnGSNY21bABNSt7',
    courseApplication: 'placeholder', // Update with actual link when available
  },
  // True only for the live site (main, deployed with --prod). Local builds,
  // the dev preview (ais4i-dev.vercel.app) and other previews are false, which
  // lets drafts such as an unapproved leadership team show there and not live.
  isProduction: process.env.VERCEL_ENV === 'production',
  // GA4 measurement ID. Only production deploys get it, so local builds and
  // Vercel previews never render the consent banner or send hits.
  analytics: {
    gaId: process.env.VERCEL_ENV === 'production' ? 'G-6TQQPS64JE' : null,
  },
};

// Validate site data on module load
const validation = validateSiteData(siteData);
if (!validation.valid) {
  logValidationErrors('site data', validation.errors);
}

module.exports = siteData;
