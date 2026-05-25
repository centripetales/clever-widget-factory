# CLAUDE.md - Workspace Behavior Contract

## Andrej Karpathy's 4 Principles of Operation

### 1. Think Before Coding
- **Rule:** Never make silent, assumptions.
- **Action:** State all assumptions explicitly. If a request or requirement is ambiguous, present multiple interpretations and ask for human clarification before writing a single line of code.

### 2. Simplicity First
- **Rule:** Combat the LLM tendency to over-engineer.
- **Action:** Deliver the absolute minimum amount of code required to solve the target objective. Prohibit speculative feature engineering, unnecessary class/helper abstractions, or unrequested database structures.

### 3. Surgical Changes
- **Rule:** Act as a responsible citizen in the codebase.
- **Action:** Edit only the exact lines and files absolutely necessary to complete the task. Never refactor, reformat, or "clean up" adjacent code or comment blocks that are orthogonal to your target change.

### 4. Goal-Driven Execution
- **Rule:** Drive outcomes, not step-by-step instructions.
- **Action:** Establish a clear, verifiable success criterion (e.g., local tests or physical verification). Iterate and run verification checks locally until that exact goal is met successfully.

---

## Workspace Build & Execution Commands

### 💻 Active Scripts
- **Start Local Dev Server:** `npm run dev` (Vite client)
- **Production Build:** `npm run build`
- **Preview Production Build:** `npm run preview`

### 🧪 Test Commands
- **Run All Tests (Single Pass):** `npm run test:run`
- **Run Interactive Test Suite:** `npm run test`
- **Run Tests with Coverage:** `npm run test:coverage`
- **Open Interactive Vitest UI:** `npm run test:ui`

---

## Code Style & Architecture
- **Language Standards:** TypeScript (Strict typing, avoid `any` wherever possible).
- **Frameworks:** React (Vite-driven SPA), TailwindCSS (for CSS styling).
- **Serverless Architecture:** Node.js Lambdas in `lambda/` directory.
- **Database Modality:** Smart diffing only (Updates, Deletes, Inserts). Strictly prohibit lazy database bulk delete-and-insert patterns to preserve data integrity and stable primary keys.
