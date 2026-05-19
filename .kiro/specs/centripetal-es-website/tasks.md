# Tasks: Centripetal ES Website

## Task List

- [x] 1. Tenant resolution logic (`src/lib/tenant.ts`)
  - [x] 1.1 Create `src/lib/tenant.ts` with `resolveTenant(hostname, pathname)` pure function
  - [x] 1.2 Implement resolution rules: localhost → stargazer-farm, known tenant domains, path-based slug, platform fallback
  - [x] 1.3 Export `useTenantContext()` React hook that reads `window.location` at mount
  - [x] 1.4 Write unit tests for all resolution branches in `src/lib/tenant.test.ts`
  - [x] 1.5 Write property-based tests using fast-check for Properties 1, 2, and 3

- [x] 2. Platform page components
  - [x] 2.1 Create `src/pages/platform/Home.tsx` with placeholder sections: hero, system explanation, farmer benefits, live insights, navigation
  - [x] 2.2 Create `src/pages/platform/About.tsx` with placeholder sections: system overview, structured records explanation, real-world deployment context
  - [x] 2.3 Create `src/pages/platform/Contact.tsx` with placeholder for contact info and collaboration inquiry

- [x] 3. PlatformLayout component
  - [x] 3.1 Create `src/components/platform/PlatformLayout.tsx` with header, main, and footer
  - [x] 3.2 Add header with Centripetal ES wordmark and NavLink navigation to `/`, `/about`, `/contact`
  - [x] 3.3 Add footer with copyright information
  - [x] 3.4 Make layout responsive (mobile, tablet, desktop) using Tailwind CSS
  - [x] 3.5 Write unit test verifying nav links and footer are present
  - [x] 3.6 Write property-based test for Property 5 (active NavLink matches current route)

- [x] 4. Router integration in `src/App.tsx`
  - [x] 4.1 Add platform routes (`/`, `/about`, `/contact`) wrapped in `PlatformLayout` as a parallel branch to existing routes
  - [x] 4.2 Add tenant-aware routing logic: when `useTenantContext()` returns `type === 'platform'`, render platform routes; otherwise render existing org routes
  - [x] 4.3 Ensure existing routes remain unchanged and localhost still defaults to stargazer-farm org context
  - [x] 4.4 Write unit tests for Property 4 (platform routes render without auth)

- [x] 5. Static asset directories
  - [x] 5.1 Create `public/images/` directory with a `.gitkeep` placeholder
  - [x] 5.2 Create `public/icons/` directory with a `.gitkeep` placeholder

- [x] 6. CloudFormation infrastructure additions
  - [x] 6.1 Add `CentripetalesBucket` S3 resource to `cloudformation/cwf-infrastructure.yaml` (static website hosting, index.html error document)
  - [x] 6.2 Add `StargazerFarmBucket` S3 resource (same configuration)
  - [x] 6.3 Add `CentripetalesDistribution` CloudFront distribution (origin: CentripetalesBucket, CNAME: centripetales.com, 403/404 → /index.html with 200)
  - [x] 6.4 Add `StargazerFarmDistribution` CloudFront distribution (origin: StargazerFarmBucket, CNAME: stargazer-farm.com, same SPA error config)
  - [x] 6.5 Add CloudFormation Parameters for ACM certificate ARNs (centripetales.com and stargazer-farm.com)
  - [x] 6.6 Add CloudFormation Outputs for both CloudFront distribution IDs and domain names

- [x] 7. GitHub Actions deployment workflow
  - [x] 7.1 Update `.github/workflows/deploy.yml`: replace GitHub Pages deployment with dual S3 deployment
  - [x] 7.2 Add `build` job: single `npm run build` step, upload `./dist` as artifact
  - [x] 7.3 Add `deploy-centripetales` job: download artifact, `aws s3 sync` to `centripetales-bucket`, CloudFront invalidation
  - [x] 7.4 Add `deploy-stargazer-farm` job: download artifact, `aws s3 sync` to `stargazer-farm-bucket`, CloudFront invalidation
  - [x] 7.5 Add required GitHub Actions secrets to workflow: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `CF_CENTRIPETALES_ID`, `CF_STARGAZER_ID`
  - [x] 7.6 Configure both deploy jobs to run in parallel (`needs: build`)
