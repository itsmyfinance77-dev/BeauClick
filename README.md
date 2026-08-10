# BeauClick

Persian-first, nationwide Iranian beauty technology platform — marketplace, booking, ecommerce, B2B wholesale, chat, and an AI Beauty Assistant. Launch market: **Yazd**. Location model: `Iran → Province → City → District/Neighborhood` — Yazd is a starting point, never a hard limit.

Two documents are the sources of truth and should be read before touching product behavior or visuals:

- **[docs/business/](docs/business/)** — what BeauClick is (business idea + business plan, Persian).
- **[docs/design/DESIGN_HANDOFF.md](docs/design/DESIGN_HANDOFF.md)** — the approved visual/UX system (screens, tokens, components, states). `docs/design/prototype-reference.html` is a **reference-only** interactive mockup — never copy it directly into production; it demonstrates layout/interaction, not architecture.
- **[docs/architecture/ARCHITECTURE_PROPOSAL.md](docs/architecture/ARCHITECTURE_PROPOSAL.md)** — how it's built, and why.

WooCommerce is the commerce/payment **engine**. It never surfaces its default theme or UI — every customer-facing screen renders through the BeauClick design system.

## Repository layout

```
docs/                          business docs, design handoff, architecture
wordpress/wp-content/
  plugins/beauclick-*/         one plugin per bounded domain (core, locations, marketplace,
                                booking, b2b, payments, chat, ai, reviews, loyalty)
  themes/beauclick/             custom PHP theme — server-renders SEO-critical pages,
                                mounts the React app-shell for interactive surfaces
app/                            React + TypeScript app-shell (Vite) — design system +
                                booking/cart/AI/chat/dashboards, built to static assets
                                the WordPress theme enqueues
```

WordPress core itself (`wp-admin/`, `wp-includes/`, root PHP files) is **not committed** — it's installed locally per the setup steps below and pulled via Composer in CI/deploy.

## Local development setup (Windows)

Recommended stack: **[Laragon](https://laragon.org/download/)** (PHP + MySQL/MariaDB + Apache/Nginx + auto virtual hosts, no Docker needed for local dev — see [architecture doc §23](docs/architecture/ARCHITECTURE_PROPOSAL.md#23-local-windows-setup) for why).

1. Install Laragon (Full edition — bundles PHP, MySQL, Composer). Start it; enable Apache (or Nginx) + MySQL from its control panel.
2. Point a Laragon virtual host at this repo's `wordpress/` folder, named `beauclick.test` (Laragon auto-detects folders under its `www/` root, or add one manually via Laragon → Menu → Apache/Nginx → sites-enabled).
3. From the repo root:
   ```bash
   # WordPress core (not committed — pulled fresh)
   cd wordpress && composer create-project johnpbloch/wordpress . --prefer-dist
   cd ..

   # Root dev tooling (PHPCS, PHPUnit, WP coding standards)
   composer install

   # Each plugin's own runtime dependencies
   for d in wordpress/wp-content/plugins/beauclick-*; do (cd "$d" && composer install); done

   # Frontend app-shell
   cd app && npm install && npm run build
   ```
4. Copy `.env.example` to `.env`, fill in DB credentials (Laragon default: user `root`, empty password) and generate WordPress salts from https://api.wordpress.org/secret-key/1.1/salt/.
5. Visit `http://beauclick.test/wp-admin/install.php` to run the WordPress installer, then activate WooCommerce and every `beauclick-*` plugin, then activate the `beauclick` theme.
6. Seed reference data (Iran provinces/cities, demo professionals): `wp bc:seed` (WP-CLI command registered by `beauclick-core`).

**If Laragon isn't installed yet:** everything under `app/` builds and runs standalone right now with only Node.js (`cd app && npm install && npm run dev`) — useful for design-system/UI work without a PHP environment. The WordPress/plugin code is complete and ready to run the moment PHP + MySQL are available; it just can't be executed or migrated until then.

## Frontend-only preview (no PHP required)

```bash
cd app
npm install
npm run dev
```

Opens a Vite dev server previewing the design system and app-shell surfaces (booking flow, cart drawer, AI panel, dashboards) against mock data — useful for verifying Persian RTL layout and visual fidelity against the design handoff independent of the WordPress backend.

## Testing

- PHP: `composer test` (PHPUnit, once a plugin's `composer install` has run and a WP test-suite DB is configured — see each plugin's `tests/` folder).
- Frontend: `cd app && npm test` (Vitest) and `npm run test:e2e` (Playwright, requires a running backend).

## Contributing conventions

- Commit prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, scoped where useful, e.g. `feat(booking): prevent double-booking on concurrent requests`.
- Never commit secrets — see `.env.example` for the full list of required environment variables and `.gitignore` for what's excluded.
- Keep `docs/architecture/ARCHITECTURE_PROPOSAL.md` updated when an implementation reveals a real deviation from the approved architecture — note the change and why, don't silently drift.
