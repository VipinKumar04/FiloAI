# filoAI

**Less digital clutter. More peace of mind.**

filoAI is a privacy-first digital decluttering agent designed to help people understand and organize files safely. The planned application will scan user-selected folders, detect identical files, use local AI to recommend categories and destinations, and execute only explicitly approved operations.

> **Status: Early development.** This repository currently contains the initial application foundation. File scanning, duplicate detection, AI recommendations, and file operations are planned features and are not yet implemented.

## Goals

- Keep file analysis local wherever practical.
- Make recommendations understandable and reviewable.
- Require user approval before changing files.
- Avoid automatic deletion.
- Record operations and support safe undo where possible.
- Make the project approachable for open-source contributors.

## Technology

- Node.js
- Express
- HTML, CSS, and vanilla JavaScript
- Node.js built-in test runner
- Planned: Ollama with a compatible Gemma model

## Requirements

- Node.js 20 or later
- npm

## Getting started

```bash
npm install
npm start
```

Open <http://localhost:3000> in your browser.

To run the tests:

```bash
npm test
```

For development with Node's watch mode:

```bash
npm run dev
```

## Current functionality

- Express server and health endpoint
- Responsive industrial-dark dashboard scaffold
- Frontend-to-backend connectivity check
- Basic automated tests
- GitHub Actions CI workflow

## Roadmap

- [ ] Secure selection and scanning of a user-approved folder
- [ ] File metadata listing and dashboard statistics
- [ ] SHA-256 duplicate detection
- [ ] Local Ollama/Gemma integration
- [ ] Structured AI organization recommendations
- [ ] Review and approval queue
- [ ] Validated file moves and conflict handling
- [ ] Operation history and safe undo
- [ ] Expanded security tests and demo documentation

## Security principles

filoAI must not scan the entire computer by default. Filesystem access will be restricted to an explicitly selected root directory. AI output will be treated as untrusted input. File operations must be validated by the backend and require explicit user approval. Destructive actions will not be performed automatically.

Do not use the early development version on important files. Test future file operations against disposable sample data first.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Bug reports, documentation improvements, tests, and focused feature contributions are welcome.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
