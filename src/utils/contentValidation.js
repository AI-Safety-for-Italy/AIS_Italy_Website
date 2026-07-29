// Validation utilities for content data
const Ajv = require('ajv');
const ajv = new Ajv();

// Define schemas for each content section
const schemas = {
  home: {
    type: 'object',
    properties: {
      hero: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          description: { type: 'string' },
          cta_text: { type: 'string' },
          cta_link: { type: 'string' },
          secondary_cta_text: { type: 'string' },
          secondary_cta_link: { type: 'string' },
        },
        required: ['title', 'subtitle'],
      },
      stats: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            count: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['count', 'label'],
        },
      },
      announcements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            emoji: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            link_text: { type: 'string' },
            link_url: { type: 'string' },
            link_target: { type: 'string' },
          },
          required: ['id', 'emoji', 'title', 'description'],
        },
      },
      recent_events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            title: { type: 'string' },
            date: { type: 'string' },
            emoji: { type: 'string' },
            participants: { type: 'string' },
            description: { type: 'string' },
            link: { type: 'string' },
          },
          required: ['id', 'title', 'date', 'emoji', 'description', 'link'],
        },
      },
      mission: {
        type: 'object',
        properties: {
          problem_title: { type: 'string' },
          problem_emoji: { type: 'string' },
          problem_description: { type: 'string' },
          problem_cta_text: { type: 'string' },
          problem_cta_link: { type: 'string' },
          solution_title: { type: 'string' },
          solution_emoji: { type: 'string' },
          solution_description: { type: 'string' },
          solution_cta_text: { type: 'string' },
          solution_cta_link: { type: 'string' },
        },
        required: [
          'problem_title',
          'problem_description',
          'solution_title',
          'solution_description',
        ],
      },
      features: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            emoji: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['id', 'emoji', 'title', 'description'],
        },
      },
      cta: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          button_text: { type: 'string' },
          button_link: { type: 'string' },
        },
        required: ['title', 'description', 'button_text', 'button_link'],
      },
    },
  },

  about: {
    type: 'object',
    properties: {
      hero: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
        },
        required: ['title', 'subtitle'],
      },
      approach: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            icon: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['id', 'icon', 'title', 'description'],
        },
      },
      team_section: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
        },
        required: ['title', 'subtitle'],
      },
      values: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            icon: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['id', 'icon', 'title', 'description'],
        },
      },
      cta: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          button_text: { type: 'string' },
          button_link: { type: 'string' },
        },
        required: ['title', 'description', 'button_text', 'button_link'],
      },
    },
  },
};

// Compile all schemas
const compiledSchemas = {};
Object.keys(schemas).forEach((key) => {
  compiledSchemas[key] = ajv.compile(schemas[key]);
});

/**
 * Validates content data against the appropriate schema
 * @param {string} section - The section name (e.g., 'home', 'about')
 * @param {object} data - The data to validate
 * @returns {object} Validation result with valid flag and errors if any
 */
function validateContentData(section, data) {
  if (!compiledSchemas[section]) {
    return {
      valid: false,
      errors: [`No validation schema found for section: ${section}`],
    };
  }

  const valid = compiledSchemas[section](data);

  if (valid) {
    return {
      valid: true,
      errors: null,
    };
  } else {
    return {
      valid: false,
      errors: compiledSchemas[section].errors.map((error) => error.message),
    };
  }
}

/**
 * Logs validation errors to console
 * @param {string} section - The section name
 * @param {object} errors - The validation errors
 */
function logValidationErrors(section, errors) {
  console.warn(`Validation errors for ${section} section:`);
  errors.forEach((error) => {
    console.warn(`  - ${error}`);
  });
}

module.exports = {
  validateContentData,
  logValidationErrors,
};
