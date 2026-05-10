/**
 * Tests for PlatformLayout component
 *
 * Unit tests: 3.5 — nav links, footer, children rendering
 * Property-based test: 3.6 — Property 5: active NavLink matches current route
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as fc from 'fast-check';
import { PlatformLayout } from './PlatformLayout';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderLayout(initialPath: string, children?: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <PlatformLayout>{children ?? <div>page content</div>}</PlatformLayout>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Unit tests — Task 3.5
// ---------------------------------------------------------------------------

describe('PlatformLayout', () => {
  describe('navigation links', () => {
    it('renders a Home nav link pointing to /', () => {
      renderLayout('/');
      // There may be multiple "Home" links (desktop + mobile); at least one must exist
      const homeLinks = screen.getAllByRole('link', { name: /^home$/i });
      expect(homeLinks.length).toBeGreaterThanOrEqual(1);
      expect(homeLinks[0]).toHaveAttribute('href', '/');
    });

    it('renders an About nav link pointing to /about', () => {
      renderLayout('/');
      const aboutLinks = screen.getAllByRole('link', { name: /^about$/i });
      expect(aboutLinks.length).toBeGreaterThanOrEqual(1);
      expect(aboutLinks[0]).toHaveAttribute('href', '/about');
    });

    it('renders a Contact nav link pointing to /contact', () => {
      renderLayout('/');
      const contactLinks = screen.getAllByRole('link', { name: /^contact$/i });
      expect(contactLinks.length).toBeGreaterThanOrEqual(1);
      expect(contactLinks[0]).toHaveAttribute('href', '/contact');
    });
  });

  describe('footer', () => {
    it('renders the footer with copyright text', () => {
      renderLayout('/');
      const year = new Date().getFullYear().toString();
      expect(screen.getByText(new RegExp(`© ${year} Centripetal ES`))).toBeInTheDocument();
    });
  });

  describe('children rendering', () => {
    it('renders children inside main', () => {
      renderLayout('/', <p>Hello from child</p>);
      const main = screen.getByRole('main');
      expect(main).toBeInTheDocument();
      expect(main).toHaveTextContent('Hello from child');
    });
  });
});

// ---------------------------------------------------------------------------
// Property-based test — Task 3.6
// Property 5: Active NavLink matches current route
// Validates: Requirements 7.4
// ---------------------------------------------------------------------------

/**
 * **Validates: Requirements 7.4**
 *
 * Property 5: For any platform route the user is currently on, the NavLink
 * corresponding to that route SHALL have the active styling applied, and all
 * other NavLinks SHALL NOT have active styling.
 *
 * Active class used: 'font-semibold'
 * Inactive class used: 'text-muted-foreground'
 */
describe('Property 5: Active NavLink matches current route', () => {
  const platformRoutes = ['/', '/about', '/contact'] as const;

  // Map each route to its expected link label
  const routeToLabel: Record<string, string> = {
    '/': 'Home',
    '/about': 'About',
    '/contact': 'Contact',
  };

  it('exactly one desktop NavLink is active for each platform route (parameterized)', () => {
    for (const route of platformRoutes) {
      const { unmount } = renderLayout(route);

      // Grab all nav links inside the desktop <nav> (aria-label="Main navigation")
      const desktopNav = screen.getByRole('navigation', { name: /main navigation/i });
      const links = Array.from(desktopNav.querySelectorAll('a'));

      const activeLinks = links.filter((link) => link.classList.contains('font-semibold'));
      const inactiveLinks = links.filter((link) => link.classList.contains('text-muted-foreground'));

      // Exactly one active link
      expect(activeLinks).toHaveLength(1);

      // The active link matches the current route
      expect(activeLinks[0]).toHaveAttribute('href', route);
      expect(activeLinks[0]).toHaveTextContent(routeToLabel[route]);

      // All other links are inactive
      expect(inactiveLinks).toHaveLength(platformRoutes.length - 1);

      unmount();
    }
  });

  it('fast-check: active NavLink always matches the current route', () => {
    /**
     * **Validates: Requirements 7.4**
     *
     * Generate one of the three platform routes. For each, assert that exactly
     * one NavLink in the desktop nav has the active class, and it corresponds
     * to the generated route.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(...platformRoutes),
        (route) => {
          const { unmount } = renderLayout(route);

          const desktopNav = screen.getByRole('navigation', { name: /main navigation/i });
          const links = Array.from(desktopNav.querySelectorAll('a'));

          const activeLinks = links.filter((link) => link.classList.contains('font-semibold'));

          // Exactly one active link
          expect(activeLinks).toHaveLength(1);

          // It matches the current route
          expect(activeLinks[0]).toHaveAttribute('href', route);

          // All other links are NOT active
          const otherLinks = links.filter((link) => link !== activeLinks[0]);
          for (const link of otherLinks) {
            expect(link.classList.contains('font-semibold')).toBe(false);
          }

          unmount();
        }
      ),
      { numRuns: 100 }
    );
  });
});
