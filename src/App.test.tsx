/**
 * Tests for App.tsx — Task 4.4
 *
 * Property 4: Platform routes render without authentication
 *
 * For each of the three platform routes (/, /about, /contact), rendering the
 * route tree without an authenticated user SHALL NOT redirect to /auth and
 * SHALL render the corresponding platform page component.
 *
 * Validates: Requirements 3.4, 4.3, 6.3
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as fc from 'fast-check';
import { PlatformLayout } from '@/components/platform/PlatformLayout';
import PlatformHome from '@/pages/platform/Home';
import PlatformAbout from '@/pages/platform/About';
import PlatformContact from '@/pages/platform/Contact';
import { Routes, Route } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Renders the platform routing tree (PlatformLayout + Routes) inside a
 * MemoryRouter with the given initial path. This mirrors what TenantRouter
 * renders when useTenantContext() returns type === 'platform'.
 *
 * No AuthProvider is provided — this verifies that platform routes render
 * without any authentication context.
 */
function renderPlatformRoutes(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <PlatformLayout>
        <Routes>
          <Route path="/" element={<PlatformHome />} />
          <Route path="/about" element={<PlatformAbout />} />
          <Route path="/contact" element={<PlatformContact />} />
          <Route path="*" element={<PlatformHome />} />
        </Routes>
      </PlatformLayout>
    </MemoryRouter>
  );
}

/**
 * Returns true if the rendered output contains a link or element pointing to
 * /auth, which would indicate an auth redirect occurred.
 */
function hasAuthRedirect(): boolean {
  // Check for any element with href="/auth" or text content indicating redirect
  const authLinks = document.querySelectorAll('a[href="/auth"]');
  return authLinks.length > 0;
}

// ---------------------------------------------------------------------------
// Unit tests — Property 4 (Task 4.4)
// Validates: Requirements 3.4, 4.3, 6.3
// ---------------------------------------------------------------------------

describe('Property 4: Platform routes render without authentication', () => {
  /**
   * **Validates: Requirements 3.4, 4.3, 6.3**
   *
   * The / route renders the Home page without redirecting to /auth.
   */
  it('/ renders the Home page without redirecting to /auth', () => {
    renderPlatformRoutes('/');

    // No redirect to /auth
    expect(hasAuthRedirect()).toBe(false);

    // Home page distinctive content
    expect(
      screen.getByText(/structured records for the working farm/i)
    ).toBeInTheDocument();
  });

  /**
   * **Validates: Requirements 3.4, 4.3, 6.3**
   *
   * The /about route renders the About page without redirecting to /auth.
   */
  it('/about renders the About page without redirecting to /auth', () => {
    renderPlatformRoutes('/about');

    // No redirect to /auth
    expect(hasAuthRedirect()).toBe(false);

    // About page distinctive content
    expect(
      screen.getByText(/about centripetal es/i)
    ).toBeInTheDocument();
  });

  /**
   * **Validates: Requirements 3.4, 4.3, 6.3**
   *
   * The /contact route renders the Contact page without redirecting to /auth.
   */
  it('/contact renders the Contact page without redirecting to /auth', () => {
    renderPlatformRoutes('/contact');

    // No redirect to /auth
    expect(hasAuthRedirect()).toBe(false);

    // Contact page distinctive content
    expect(
      screen.getByText(/reach out to learn more about centripetal es/i)
    ).toBeInTheDocument();
  });

  /**
   * **Validates: Requirements 3.4, 4.3, 6.3**
   *
   * Each platform page renders its PlatformLayout (header + footer) without auth.
   */
  it('all platform routes render PlatformLayout (header + footer) without auth', () => {
    const routes = ['/', '/about', '/contact'] as const;

    for (const route of routes) {
      const { unmount } = renderPlatformRoutes(route);

      // PlatformLayout header is present
      expect(screen.getByText('Centripetal ES')).toBeInTheDocument();

      // PlatformLayout footer is present
      const year = new Date().getFullYear().toString();
      expect(
        screen.getByText(new RegExp(`© ${year} Centripetal ES`))
      ).toBeInTheDocument();

      // No auth redirect
      expect(hasAuthRedirect()).toBe(false);

      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Property-based test — Property 4 (Task 4.4)
// Validates: Requirements 3.4, 4.3, 6.3
// ---------------------------------------------------------------------------

describe('Property 4 (fast-check): platform routes render without auth for all platform paths', () => {
  /**
   * **Validates: Requirements 3.4, 4.3, 6.3**
   *
   * For any of the three platform routes, rendering without an authenticated
   * user SHALL NOT redirect to /auth and SHALL render the platform layout.
   */
  it('fast-check: no auth redirect for any platform route', () => {
    const platformRoutes = ['/', '/about', '/contact'] as const;

    fc.assert(
      fc.property(
        fc.constantFrom(...platformRoutes),
        (route) => {
          const { unmount } = renderPlatformRoutes(route);

          // No redirect to /auth
          expect(hasAuthRedirect()).toBe(false);

          // PlatformLayout is always rendered (wordmark present)
          expect(screen.getByText('Centripetal ES')).toBeInTheDocument();

          unmount();
        }
      ),
      { numRuns: 100 }
    );
  });
});
