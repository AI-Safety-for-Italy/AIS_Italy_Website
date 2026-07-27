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
    role: 'Organizing Team — Communications & Community',
    photo: '/assets/img/team/carola-caivano.jpeg',
    bio: 'Carola is part of the organizing group of AI Safety for Italy, contributing to the development of the initiative across external communications, community strategy, and networking. Her background is in physics and she currently works as a data scientist. Her involvement in AI safety includes participating in the ML4Good bootcamp and graduating from BlueDot Impact’s AI Alignment course.',
    areas: ['Communications & Social Media', 'Community'],
    interests: ['AI Strategy', 'Technical safety', 'AI governance'],
    links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/carolacaivano/' }],
  },
  {
    name: 'Elisabetta Rocchetti',
    role: 'Co-founding Collaborator — PhD Candidate',
    photo: '/assets/img/team/elisabetta-rocchetti.jpg',
    bio: 'Elisabetta is a co-founding collaborator of AI Safety for Italy and a PhD candidate in Computer Science at Università degli Studi di Milano, where her research focuses on mechanistic interpretability. Her work spans refusal behaviour, instruction-following mechanisms, training dynamics, and the encoding of aesthetic concepts, using methods such as activation patching, steering, probing, and complex network modeling.',
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
    areas: ['Website & Technical Infrastructure', 'Didactics'],
    interests: ['Autoformalization', 'Formal Monitoring'],
    links: [
      { label: 'Website', url: 'https://cristian-curaba.github.io' },
      { label: 'GitHub', url: 'https://github.com/Cristian-Curaba' },
    ],
  },
  {
    name: 'Francesco Ortu',
    role: 'Co-founder — PhD Student',
    bio: 'Francesco is a co-founder of AI Safety for Italy and a PhD student at the University of Trieste and Area Science Park. His research focuses on the mechanistic interpretability of LLMs and VLMs. As part of his PhD, he visited the AI Safety and Alignment group at the ELLIS Institute in Tübingen.',
    areas: ['General Operations & Coordination', 'Mentorship'],
    interests: ['Mechanistic interpretability', 'Societal implication of AI'],
    links: [{ label: 'Website', url: 'https://francescortu.github.io/' }],
  },
  {
    name: 'Luca Scionis',
    role: 'PhD Student',
    bio: 'Luca Scionis is a PhD student in the Italian National AI PhD Programme, affiliated with the University of Cagliari (sAIferLab). He is currently an ELLIS intern working on the AI safety of AI agents. His research spans adversarial machine learning, with a focus on the robustness of computer vision models, and AI safety, particularly the security of LLM-based agents and assistants.',
    areas: ['Community Events', 'Mentorship'],
    interests: [
      'Technical AI safety',
      'Adversarial machine learning',
      'Robustness of ML models',
      'Security of LLM-based agents and assistants',
    ],
    links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/luca-scionis-148b37251/' }],
  },
];

module.exports = validateTeamData(teamData);
