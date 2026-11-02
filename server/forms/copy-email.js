// The email with a copy of someone's answers to a form (the form's `sendCopy`
// setting; see forms.submit and forms.sendCopy).
//
//   copyOf(schema, answers, to)  -> { to, lang, title, rows: [{ label, value }] }
//   render(copy, origin)         -> { subject, text, html }
//
// The copy is built from the cleaned answers when the form is sent, and drawn
// only when it is mailed, with the site's address for the logo. The HTML is
// made of tables with inline styles, the one layout mail apps agree on, and
// every answer is escaped: it is whatever the sender typed.

const schemaLib = require('./schema');

const COLORS = {
  page: '#f3f5f3',
  card: '#ffffff',
  border: '#e3e8e4',
  accent: '#006f38',
  accentSoft: '#f0faf4',
  text: '#0f1a14',
  muted: '#5b6b61',
  faint: '#7c8a81',
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "'Source Serif 4',Georgia,'Times New Roman',serif";

const WORDS = {
  it: {
    subject: (t) => `Le tue risposte: ${t}`,
    eyebrow: 'Le tue risposte',
    intro: (t) => `Grazie per aver compilato “${t}”. Ecco una copia di quello che hai inviato.`,
    why: 'Hai ricevuto questa email perché questo indirizzo è stato inserito nel modulo. Se non sei stato tu, puoi ignorarla.',
    noReply: 'Email inviata automaticamente: per favore non rispondere.',
  },
  en: {
    subject: (t) => `Your answers: ${t}`,
    eyebrow: 'Your answers',
    intro: (t) => `Thank you for filling in “${t}”. Here is a copy of what you sent.`,
    why: 'You got this email because this address was given in the form. If it was not you, you can ignore it.',
    noReply: 'Automatic email, please do not reply.',
  },
};

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/** The questions answered, as text, in the form's main language. */
function copyOf(schema, answers, to) {
  const lang = schema.languages[0];
  const rows = [];
  for (const item of schemaLib.answerable(schema)) {
    if (answers[item.id] === undefined) continue;
    rows.push({
      label: schemaLib.textIn(schema, item.label, lang),
      value: schemaLib.answerText(schema, item, answers[item.id]),
    });
  }
  return { to, lang, title: schemaLib.textIn(schema, schema.title, lang), rows };
}

function text(copy, w) {
  return [
    w.intro(copy.title),
    ...copy.rows.map((r) => `${r.label}\n${r.value}`),
    w.why,
    w.noReply,
  ].join('\n\n');
}

function html(copy, w, origin) {
  const site = String(origin || '').replace(/\/+$/, '');
  const logo = site
    ? `<img src="${escapeHtml(
        site
      )}/assets/img/ais4i-logo-512.png" width="36" height="36" alt="" style="display:block;border:0;width:36px;height:36px">`
    : '';
  const rows = copy.rows
    .map(
      (r, i) => `
          <tr><td style="padding:${i ? '18px' : '4px'} 0 18px;${
        i ? `border-top:1px solid ${COLORS.border};` : ''
      }">
            <div style="font:600 13px/1.4 ${SANS};color:${
        COLORS.muted
      };margin:0 0 6px">${escapeHtml(r.label)}</div>
            <div style="font:400 15px/1.55 ${SANS};color:${
        COLORS.text
      };word-break:break-word">${escapeHtml(r.value).replace(/\n/g, '<br>')}</div>
          </td></tr>`
    )
    .join('');
  return `<!doctype html>
<html lang="${
    copy.lang
  }"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(w.subject(copy.title))}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(
    w.intro(copy.title)
  )}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${
    COLORS.page
  }">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
      <tr><td style="padding:0 4px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          ${logo ? `<td style="padding-right:10px;vertical-align:middle">${logo}</td>` : ''}
          <td style="vertical-align:middle;font:600 16px/1.2 ${SERIF};color:${
    COLORS.text
  }">AI Safety <span style="color:${COLORS.accent}">for Italy</span></td>
        </tr></table>
      </td></tr>
      <tr><td style="background:${COLORS.card};border:1px solid ${
    COLORS.border
  };border-top:4px solid ${COLORS.accent};border-radius:12px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:28px 28px 8px">
            <div style="font:700 12px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${
    COLORS.accent
  }">${escapeHtml(w.eyebrow)}</div>
            <h1 style="margin:6px 0 12px;font:600 24px/1.25 ${SERIF};color:${
    COLORS.text
  }">${escapeHtml(copy.title)}</h1>
            <p style="margin:0;font:400 15px/1.55 ${SANS};color:${COLORS.muted}">${escapeHtml(
    w.intro(copy.title)
  )}</p>
          </td></tr>
          <tr><td style="padding:16px 28px 12px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${
              COLORS.accentSoft
            };border-radius:10px">
              <tr><td style="padding:6px 20px">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
                </table>
              </td></tr>
            </table>
          </td></tr>
          <tr><td style="padding:12px 28px 28px;font:400 13px/1.55 ${SANS};color:${
    COLORS.faint
  }">${escapeHtml(w.why)}</td></tr>
        </table>
      </td></tr>
      <tr><td align="center" style="padding:20px 8px 0;font:400 12px/1.6 ${SANS};color:${
    COLORS.faint
  }">
        ${
          site
            ? `<a href="${escapeHtml(site)}/" style="color:${
                COLORS.accent
              };text-decoration:none;font-weight:600">AI Safety for Italy</a><br>`
            : 'AI Safety for Italy<br>'
        }${escapeHtml(w.noReply)}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** The email for a copy: { subject, text, html }. `origin`: the site, for the logo. */
function render(copy, origin) {
  const w = WORDS[copy.lang] || WORDS.it;
  return { subject: w.subject(copy.title), text: text(copy, w), html: html(copy, w, origin) };
}

module.exports = { copyOf, render };
