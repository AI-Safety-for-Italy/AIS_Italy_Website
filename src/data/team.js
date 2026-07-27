const { validateTeamMember, logValidationErrors } = require('../utils/validation');

/**
 * Validates an array of team members
 * @param {Array} teamMembers - Array of team member objects to validate
 * @returns {Array} The validated team members array
 * @throws {Error} If input is not an array
 */
function validateTeamData(teamMembers) {
  const errors = [];

  if (!Array.isArray(teamMembers)) {
    throw new Error('Team data must be an array');
  }

  teamMembers.forEach((member, index) => {
    const validation = validateTeamMember(member);
    if (!validation.valid) {
      errors.push(
        `Team member ${index} (${member.name || 'unknown'}): ${validation.errors.join(', ')}`
      );
    }
  });

  if (errors.length > 0) {
    logValidationErrors('team data', errors);
  }

  return teamMembers;
}

// Active members of AI Safety for Italy.
// `photo` is a path under /assets/img/team/ (omit to fall back to initials).
// `areas` are contribution areas, `interests` are research/topic interests,
// and `links` are contact links shown on the card.
const teamData = [
  {
    name: 'Valeriia Povergo',
    role: 'Organizing Team — Operations & Governance',
    bio: 'Valeriia is part of the organizing group of AI Safety for Italy, contributing to the coordination and development of the initiative across governance, finance, communications, and operational support. Her background is primarily in operations, project coordination, stakeholder relationship development, and fundraising across international initiatives and campaigns. She has experience supporting organizational processes, cross-functional coordination, and the development of operational infrastructure. Her recent involvement in AI safety includes participation in initiatives such as AI Safety Camp, Apart Research, and the Corda Democracy Fellowship.',
    bio_it:
      'Valeriia fa parte del gruppo organizzativo di AI Safety for Italy, contribuendo alla coordinazione e allo sviluppo dell’iniziativa su governance, finanza, comunicazione e supporto operativo. Il suo background è principalmente in ambito operativo, coordinamento di progetti, sviluppo di relazioni con gli stakeholder e fundraising attraverso iniziative e campagne internazionali. Ha esperienza nel supporto ai processi organizzativi, nella coordinazione interfunzionale e nello sviluppo di infrastrutture operative. Il suo coinvolgimento recente nell’AI safety include la partecipazione a iniziative come AI Safety Camp, Apart Research e il Corda Democracy Fellowship.',
    areas: [
      'Governance & Finance',
      'General Operations & Coordination',
      'Communications & Social Media',
    ],
    interests: [
      'AI Policy and Governance',
      'AI Forecasting and Strategy',
      'AI-generated content regulation',
    ],
    links: [],
  },
  {
    name: 'Carola Caivano',
    role: 'Co-founder — Communications & Community',
    photo: '/assets/img/team/carola-caivano.jpeg',
    bio: 'Carola is a co-founder of AI Safety for Italy, contributing to the development of the initiative in external communication, community strategy, and networking. Her background is in physics, and she currently works as a data scientist. Her involvement in AI safety includes participation in the ML4Good bootcamp and completion of the AI Alignment course by BlueDot Impact.',
    bio_it:
      'Carola è co-founder di AI Safety for Italy, contribuendo allo sviluppo della costruzione della community. Il suo background è in fisica e attualmente lavora come data scientist. Il suo coinvolgimento nell’AI safety include la partecipazione al bootcamp ML4Good e il completamento del corso AI Alignment di BlueDot Impact.',
    areas: ['Communications & Social Media', 'Community'],
    interests: ['AI Strategy', 'Technical safety', 'AI governance'],
    links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/carolacaivano/' }],
  },
  {
    name: 'Elisabetta Rocchetti',
    role: 'Co-foununder — Operations & Community',
    photo: '/assets/img/team/elisabetta-rocchetti.jpg',
    bio: 'Elisabetta is a co-founding collaborator of AI Safety for Italy and a PhD candidate in Computer Science at Università degli Studi di Milano, where her research focuses on mechanistic interpretability. Her work spans refusal behaviour, instruction-following mechanisms, training dynamics, and the encoding of aesthetic concepts, using methods such as activation patching, steering, probing, and complex network modeling.',
    bio_it:
      'Elisabetta è una co-founding collaborator di AI Safety for Italy e dottoranda in Informatica presso l’Università degli Studi di Milano, dove la sua ricerca si concentra sull’interpretabilità meccanicistica. Il suo lavoro riguarda il refusal behavior, i meccanismi di instruction-following, la dinamica di training e la codifica di concetti estetici, utilizzando metodi come activation patching, steering, probing e modellazione di reti complesse.',
    areas: [
      'General Operations & Coordination',
      'Community building',
      'Mentorship',
      'Governance & Finance',
    ],
    interests: ['Mechanistic interpretability', 'Technical AI safety', 'AI alignment'],
    links: [
      { label: 'LinkedIn', url: 'https://www.linkedin.com/in/elisabetta-rocchetti-70a953143/' },
    ],
  },
  {
    name: 'Cristian Curaba',
    role: 'Technical Infrastructure & Didactics',
    photo: '/assets/img/team/cristian-curaba.jpg',
    bio: 'Cristian holds a Master’s degree in Data Science and Scientific Computing and a Bachelor’s in Mathematics, providing him with a rigorous analytical and problem-solving foundation. He actively participated in the Apart Fellowship, ML4Good France, and various related courses. His involvement extends to local community building, where he currently leads an AGI Safety Discussion Group at the University of Udine to engage researchers and students in critical AI safety topics.',
    bio_it:
      'Cristian possiede una laurea magistrale in Data Science and Scientific Computing e una laurea triennale in Matematica, il che gli fornisce una solida base analitica e di problem-solving. Ha partecipato attivamente all’Apart Fellowship, a ML4Good France e a vari corsi correlati. Il suo coinvolgimento si estende alla costruzione di community locali, dove attualmente guida un AGI Safety Discussion Group presso l’Università di Udine per coinvolgere ricercatori e studenti su temi critici dell’AI safety.',
    areas: ['Website & Technical Infrastructure', 'Didactics'],
    interests: ['Autoformalization', 'Formal Monitoring'],
    links: [
      { label: 'Website', url: 'https://cristian-curaba.github.io' },
      { label: 'GitHub', url: 'https://github.com/Cristian-Curaba' },
    ],
  },
  {
    name: 'Francesco Ortu',
    role: 'Co-founder — Operations & Mentorship',
    photo: '/assets/img/team/francesco-ortu.png',
    bio: 'Francesco is a co-founder of AI Safety for Italy and a PhD student at the University of Trieste and Area Science Park. His research focuses on the mechanistic interpretability of LLMs and VLMs. As part of his PhD, he visited the AI Safety and Alignment group at the ELLIS Institute in Tübingen.',
    bio_it:
      'Francesco è co-founder di AI Safety for Italy e dottorando presso l’Università di Trieste e Area Science Park. La sua ricerca si concentra sull’interpretabilità meccanicistica di LLM e VLM. Nel corso del suo dottorato ha visitato il gruppo AI Safety and Alignment presso l’ELLIS Institute di Tübingen.',
    areas: ['General Operations & Coordination', 'Mentorship'],
    interests: ['Mechanistic interpretability', 'Societal implication of AI'],
    links: [{ label: 'Website', url: 'https://francescortu.github.io/' }],
  },
  {
    name: 'Luca Scionis',
    role: 'Community & Mentorship',
    bio: 'Luca Scionis is a PhD student in the Italian National AI PhD Programme, affiliated with the University of Cagliari (sAIferLab). He is currently an ELLIS intern working on the AI safety of AI agents. His research spans adversarial machine learning, with a focus on the robustness of computer vision models, and AI safety, particularly the security of LLM-based agents and assistants.',
    bio_it:
      'Luca Scionis è dottorando nel National AI PhD Programme italiano, affiliato all’Università di Cagliari (sAIferLab). Attualmente è ELLIS intern e lavora sulla sicurezza degli agenti AI. La sua ricerca spazia nell’adversarial machine learning, con un focus sulla robustezza dei modelli di computer vision, e nell’AI safety, in particolare nella sicurezza di agenti e assistenti basati su LLM.',
    areas: ['Community Events', 'Mentorship'],
    interests: [
      'Technical AI safety',
      'Adversarial machine learning',
      'Robustness of ML models',
      'Security of LLM-based agents and assistants',
    ],
    links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/luca-scionis-148b37251/' }],
  },
  {
    name: 'Madhusudhan Pathak',
    role: 'Communications & Technical Infrastructure',
    photo: '/assets/img/team/madhusudhan-pathak.jpg',
    bio: 'Working on pioneering the Artificial Wisdom paradigm, a fundamental reconceptualization of AI alignment that positions meta-ethical reasoning and contextual understanding. This research challenges the conventional approach of treating ethics as post-hoc overlays on optimization systems, proposing instead that wisdom must be embedded at the foundational level of AI architecture.',
    bio_it:
      'Lavora per pioniere il paradigma dell’Artificial Wisdom, una riconcettualizzazione fondamentale dell’AI alignment che posiziona il ragionamento meta-etico e la comprensione contestuale. Questa ricerca sfida l’approccio convenzionale che tratta l’etica come sovrapposizione post-hoc sui sistemi di ottimizzazione, proponendo invece che la saggezza debba essere integrata al livello fondamentale dell’architettura dell’IA.',
    areas: [
      'Communications & Social Media',
      'Website & Technical Infrastructure',
    ],
    interests: [
      'Technical AI Safety',
      'AI Ethics',
      'Machine Ethics',
      'Philosophy x AI',
    ],
    links: [
      { label: 'LinkedIn', url: 'https://www.linkedin.com/in/MadMyspy/' },
      { label: 'Website', url: 'https://myspy.vercel.app/' },
    ],
  },
  {
    name: 'Luca Mattiazzi',
    role: 'Website & Technical Infrastructure',
    photo: '/assets/img/team/luca-mattiazzi.png',
    bio: 'An AI Engineer with several years of Software and ML Engineering experience and a biotechnology degree. Currently interested in mechanistic interpretability and generally in interpretable machine learning.',
    bio_it:
      'Un AI Engineer con diversi anni di esperienza in Software e ML Engineering e una laurea in biotecnologie. Attualmente interessato all’interpretabilità meccanicistica e in generale al machine learning interpretabile.',
    areas: ['Website & Technical Infrastructure'],
    interests: [
      'Mechanistic Interpretability',
      'AI Alignment',
      'Technical AI Safety',
    ],
    links: [{ label: 'Website', url: 'https://grokked.it' }],
  },
  {
    name: 'Lorenzo Basile',
    role: 'Co-founder — Governance & Mentorship',
    bio: 'Lorenzo is a co-founder of AI Safety for Italy and a postdoctoral researcher at Area Science Park (Trieste). His research focuses on the interpretability of multimodal foundation models and representation alignment. He previously obtained a PhD in AI at the University of Trieste, supervised by Luca Bortolussi, with a research visit in Francesco Locatello’s Causal Learning and AI lab at IST Austria.',
    bio_it:
      'Lorenzo è co-founder di AI Safety for Italy e ricercatore post-doc presso Area Science Park (Trieste). La sua ricerca si concentra sull’interpretabilità dei modelli fondazionali multimodali e sull’allineamento delle rappresentazioni. In precedenza ha conseguito un dottorato in IA presso l’Università di Trieste, sotto la supervisione di Luca Bortolussi, con un periodo di ricerca presso il laboratorio di Causal Learning and AI di Francesco Locatello all’IST Austria.',
    areas: ['Mentorship', 'Governance and Funding'],
    interests: ['Mechanistic interpretability', 'Technical AI Safety'],
    links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/lorebasile/' }],
  },
];

module.exports = validateTeamData(teamData);