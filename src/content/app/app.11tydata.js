// Every page of the signed-in area (/app/) loads the meeting-poll stylesheet
// and head tags. All but the sign-in page are drawn in the frame of
// src/components/app.njk (sidebar, top bar, search), which replaces the
// site's header and footer there.
module.exports = {
  meetHead: true,
  appArea: true,
  eleventyComputed: {
    appShell: (data) => Boolean(data.page && data.page.url && data.page.url !== '/app/login/'),
  },
};
