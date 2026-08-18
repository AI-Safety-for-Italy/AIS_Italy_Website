# Contributing to AI Safety Italia Website

Thank you for your interest in contributing to the AI Safety Italia Website! We appreciate your help in improving our platform.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/AI-Safety-for-Italy/AIS_Italy_Website`
3. Navigate to the project directory: `cd AIS_Italy_Website`
4. Install dependencies: `npm install`
5. Create a new branch: `git checkout -b feature/your-feature-name`

## Development Workflow

### Making Changes

1. Make your changes in the appropriate files in the `src/` directory
2. Test your changes locally: `npm start`
3. Ensure your code follows the project's style by running: `npm run format`
4. Commit your changes with a descriptive message

### Code Style

- Follow the existing code style and conventions
- Use meaningful variable and function names
- Write clear, concise comments where necessary
- Ensure accessibility best practices are followed

### Commit Messages

Write clear, descriptive commit messages that explain what changes were made and why. Follow the format:

```
feat: add new feature
fix: resolve issue
docs: update documentation
style: format code
refactor: restructure code
test: add tests
chore: maintenance tasks
```

## Pull Request Process

1. Ensure your branch is up to date with the main branch
2. Run `npm run build` to ensure everything builds correctly
3. Submit a pull request to the main branch
4. Describe your changes in detail in the pull request description
5. Wait for review and address any feedback

## Technical Details

### Project Structure

- `src/content/` - Page content in Markdown format
- `src/components/` - Reusable Nunjucks components
- `src/components/base.njk` - Page shell, pulled in with `{% extends %}`
- `src/data/` - Site-wide data files
- `src/assets/` - CSS, JavaScript, images, and other assets

### Available Scripts

- `npm start` - Start development server with hot reload
- `npm run build` - Build the site for production
- `npm run clean` - Remove build output
- `npm run format` - Format code with Prettier
- `npm run lint` - Lint JavaScript files

## Questions?

If you have any questions, feel free to open an issue or contact us at aisafetyitalia@gmail.com.

Thank you for contributing!