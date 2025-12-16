CodeSense (Phase 1)

A local-first, privacy-focused intelligence engine for your codebase.

🚧 Status: Pre-Alpha / Experimental
Currently building the foundational indexing layers.

🕵️ What is CodeSense?

CodeSense is an engine designed to create a comprehensive, tiered index of your source code. Unlike most modern tools that rely on cloud APIs or heavy external services, CodeSense runs entirely on your machine.

It builds a portable "memory" of your project—stored in a single SQLite file—enabling instant access to file metadata, code structure, and (eventually) semantic understanding.

Core Philosophy:

Local-First: No data leaves your machine. Your code stays yours.

Zero-Config: Works out of the box with standard defaults.

Performance: Built on better-sqlite3 and sqlite-vec for blazing fast synchronous operations.

🏗️ Architecture

We are building a Tiered Indexing System:

Tier 0: The Scanner (✅ Completed)

Rapidly walks the file system.

Respects .gitignore and default ignore patterns.

Calculates content hashes to detect changes efficiently.

Result: A clean list of active files vs. modified/deleted files.

Tier 1: The Structure (🚧 Coming Soon)

Uses Tree-sitter to parse code into ASTs (Abstract Syntax Trees).

Extracts symbols (functions, classes, variables) without executing code.

Result: A searchable map of where things are defined.

Tier 2: The Meaning (🔮 Planned)

Generates vector embeddings for code chunks.

Enables semantic search ("Where is the auth logic?" vs "grep auth").

Result: A vector store embedded directly in the same SQLite file.

🚀 Getting Started

Prerequisites

Node.js (v20+)

Setup

# 1. Clone the repo
git clone [https://github.com/your-username/codesense.git](https://github.com/your-username/codesense.git)
cd codesense

# 2. Install dependencies
npm install


Running the Scanner (Phase 1)

You can run the engine against any local directory to see the Tier 0 scanner in action:

# Scan the current directory
npm start .

# Or scan a specific project
npm start ../path/to/another/project


You will see a codesense.db file created in your working directory. This file contains the state of your codebase.

🛠️ Tech Stack

Runtime: Node.js (ES Modules)

Database: better-sqlite3 (Synchronous SQLite driver)

Vectors: sqlite-vec (In-process vector search extension)

Scanner: fast-glob (High-performance file walker)

📈 Progress

[x] Project Scaffolding

[x] Database Layer (SQLite + Vector Extension)

[x] Tier 0: Smart Scanner & Hashing

[ ] Tier 1: Tree-sitter Parser Integration

[ ] Tier 2: Vector Embedding Generation

[ ] Query API

📄 License

MIT