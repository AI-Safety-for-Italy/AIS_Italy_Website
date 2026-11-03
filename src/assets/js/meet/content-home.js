/* /app/content/: a box per part of the content tool (seminars, events),
 * shown by app-common.js to whoever holds its key; here, each box's faces
 * (who can use that part, /api/app/access), and a word when none is open. */
(function () {
  'use strict';
  var M = window.Meet;

  M.permissions
    .then(function (perms) {
      var shown = 0;
      document.querySelectorAll('.content-part').forEach(function (box) {
        if (perms.indexOf(box.getAttribute('data-needs')) === -1) return;
        shown++;
        var slot = box.querySelector('.content-part-faces');
        M.api(
          'GET',
          '/api/app/access?tool=content&section=' +
            encodeURIComponent(slot.getAttribute('data-section'))
        )
          .then(function (r) {
            slot.appendChild(M.accessFaces(r.access));
          })
          .catch(function () {
            /* no faces: the box still opens the part */
          });
      });
      document.getElementById('contentNone').hidden = shown > 0;
    })
    .catch(M.appError);
})();
