# Requirements Document

## Introduction

Centripetal ES is a real-world agricultural system that organizes farmer assets, observations, and actions over time into structured records. This document defines the requirements for the Centripetal ES platform website at centripetales.com.

The site is not a SaaS application or dashboard — it is a conceptual, explanatory, and onboarding website that communicates what the system does and how it helps farmers. It is built using the existing CWF tech stack (React 18 + TypeScript + Vite + Tailwind CSS + React Router v7) within the existing repository.

The platform supports multi-tenant routing so that individual farm portals (e.g., centripetales.com/stargazer-farm or stargazer-farm.com) can coexist with the public Centripetal ES site under one codebase and one deployment pipeline.

---

## Glossary

- **Centripetal_ES**: The agricultural system being described and promoted by this website.
- **Platform**: The centripetales.com site — the public-facing layer of the Centripetal ES system.
- **Tenant**: An organization (farm) identified by its `subdomain` field in the `organizations` table.
- **Org_Slug**: The `subdomain` value for an organization, used to scope routing and branding (e.g., `stargazer-farm`).
- **Visitor**: Any person browsing the public platform site without authentication.
- **Observer**: A user (e.g., ATI, TESDA) with read-only cross-org access — deferred to a future spec.
- **Page**: A distinct URL-addressable React component within the platform.
- **PlatformLayout**: The shared layout component wrapping all public platform pages with header, footer, and navigation.

---

## Requirements

### Requirement 1: Project Structure and Technology Foundation

**User Story:** As a developer, I want a well-organized React + Vite project structure that supports multi-tenant routing and multi-domain deployment, so that I can serve both the Centripetal ES platform and individual farm portals from a single codebase.

#### Acceptance Criteria

1. THE Website SHALL use the existing tech stack: React 18 + TypeScript, Vite, Tailwind CSS, React Router v7, shadcn-ui + Radix UI.
2. THE Website SHALL live in the existing CWF repository — no separate repo is required.
3. THE Website SHALL introduce a platform-level routing structure:
   - `/` → Centripetal ES public site (no auth required)
   - `/:org-slug/` → org-scoped operational app (auth required, org branding)
4. THE app SHALL resolve tenant context from the `subdomain` field of the `organizations` table — the existing field already used for org identity.
5. THE app SHALL resolve tenant context at startup using two signals:
   - Hostname (e.g., `stargazer-farm.com` → look up org by `subdomain = 'stargazer-farm'`)
   - URL path segment (e.g., `centripetales.com/stargazer-farm` → same lookup)
6. THE tenant resolution logic SHALL live in `src/lib/tenant.ts` as the single source of truth.
7. IN development (`localhost`), THE tenant SHALL default to Stargazer Farm so existing app behavior is unchanged.
8. THE project SHALL organize platform-specific files under:
   - `src/pages/platform/` — platform page components
   - `src/components/platform/` — platform-specific reusable UI
   - `src/lib/` — utilities, tenant logic, domain models
   - `public/images/`, `public/icons/` — static assets
   - `src/styles/` — global CSS
9. THE GitHub Actions workflow SHALL build the app once and deploy the same artifact to both `centripetales-bucket` and `stargazer-farm-bucket` (S3) in parallel, each with its own CloudFront distribution.
10. THE two CloudFront distributions SHALL be defined in `cloudformation/cwf-infrastructure.yaml`.
11. IF a new org tenant is added, THEN only a new `subdomain` value in the database is required — no frontend code changes needed.

---

### Requirement 3: Homepage

**User Story:** As a developer, I want a homepage route and component structure at centripetales.com, so that I can fill in the content later without restructuring the routing or layout.

#### Acceptance Criteria

1. THE Homepage SHALL be a React component at `src/pages/platform/Home.tsx`.
2. THE Homepage route SHALL be accessible at `/` when the app is accessed via `centripetales.com`.
3. THE Homepage component SHALL include placeholder sections for: hero, system explanation, farmer benefits, live insights, and navigation.
4. THE Homepage SHALL render without requiring authentication.
5. THE Homepage component MAY use placeholder text or empty sections — actual content will be filled in later.
6. THE Homepage SHALL be styled using Tailwind CSS and shadcn-ui components consistent with the existing app.

---

### Requirement 4: About / System Page

**User Story:** As a developer, I want an about/system page route and component at centripetales.com/about, so that a deeper explanation of how Centripetal ES works can be added later without restructuring.

#### Acceptance Criteria

1. THE About Page SHALL be a React component at `src/pages/platform/About.tsx`.
2. THE route SHALL be accessible at `/about` via `centripetales.com`.
3. THE page SHALL render without requiring authentication.
4. THE page SHALL include placeholder sections for:
   - System overview (what Centripetal ES is)
   - How structured records work (assets, observations, actions over time)
   - Real-world deployment context (grounded in actual farm usage)
5. THE page SHALL use Tailwind CSS and shadcn-ui components consistent with the existing app.
6. Actual content SHALL be filled in later — placeholders are sufficient at this stage.

---

### Requirement 6: Contact Page

**User Story:** As a developer, I want a contact page route and component at centripetales.com/contact, so that collaboration inquiries have a destination — content to be filled in later.

#### Acceptance Criteria

1. THE Contact Page SHALL be a React component at `src/pages/platform/Contact.tsx`.
2. THE route SHALL be accessible at `/contact` via `centripetales.com`.
3. THE page SHALL render without requiring authentication.
4. THE page SHALL include a placeholder for contact information and collaboration inquiry — actual content to be filled in later.
5. THE page SHALL use Tailwind CSS and shadcn-ui components consistent with the existing app.

---

### Requirement 7: Shared Layout, Header, Footer, Navigation

**User Story:** As a Visitor, I want consistent navigation and layout across all platform pages, so that I can move through the site without confusion.

#### Acceptance Criteria

1. THE app SHALL include a shared layout component at `src/components/platform/PlatformLayout.tsx` that wraps all platform pages with a consistent header and footer.
2. THE header SHALL display the Centripetal ES name/logo and navigation links to: Home (`/`), About (`/about`), Contact (`/contact`).
3. THE footer SHALL display copyright information and any secondary links.
4. WHEN a Visitor is on a given page, THE navigation SHALL visually indicate the active route using React Router's `NavLink`.
5. THE layout SHALL be responsive across mobile, tablet, and desktop.

---

### Requirement 8: Static Asset Management

**User Story:** As a developer, I want a clear location for all static assets, so that images, icons, and fonts are easy to find, reference, and replace.

#### Acceptance Criteria

1. THE Website SHALL store static assets (images, icons, fonts) in the `public/` directory organized by type: `public/images/`, `public/icons/`.
2. Dynamic farm content images (action photos, tool images) SHALL be referenced by their existing S3 URLs from the CWF backend — no new upload pattern needed for the platform site.
3. THE Website SHALL not embed images over 200KB as inline data URIs in component files.
