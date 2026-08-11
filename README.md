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

You need PHP, MySQL, Composer, and WP-CLI available. **[Laragon](https://laragon.org/download/)** is a convenient way to get PHP + MySQL + Composer bundled on Windows with no Docker needed — but this project does **not** use Laragon's Apache/Nginx virtual-host layer. WordPress is served by **PHP's own built-in development server**, driven by the committed [`wordpress/router.php`](wordpress/router.php) (which exists specifically to make pretty permalinks work under `php -S`, since it has no `.htaccess`/`mod_rewrite` support). This keeps the whole stack to one process, matches `.env`'s `WP_HOME=http://localhost:8080` exactly, and avoids maintaining a separate vhost config. If you already have PHP + MySQL from any other source (a standalone install, WAMP/XAMPP, WSL, etc.), that works too — Laragon just needs to be running for its MySQL service, not its web server.

1. Get PHP + MySQL running (Laragon: install, start it, enable MySQL from its control panel — you do **not** need to enable Apache/Nginx, and you do **not** need to create a virtual host).
2. From the repo root:
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
3. Copy `.env.example` to `.env`, fill in DB credentials (Laragon default: user `root`, empty password) and generate WordPress salts from https://api.wordpress.org/secret-key/1.1/salt/. Leave `WP_HOME`/`WP_SITEURL` as `http://localhost:8080` unless you have a reason to change them.
4. Start the dev server from the `wordpress/` folder:
   ```bash
   cd wordpress && php -S localhost:8080 router.php
   ```
5. Visit `http://localhost:8080/wp-admin/install.php` to run the WordPress installer, then activate WooCommerce and every `beauclick-*` plugin, then activate the `beauclick` theme.
6. Seed reference data (Iran provinces/cities, demo professionals): `wp bc:seed` (WP-CLI command registered by `beauclick-core`).

**If PHP/MySQL aren't available yet:** everything under `app/` builds and runs standalone right now with only Node.js (`cd app && npm install && npm run dev`) — useful for design-system/UI work without a PHP environment. The WordPress/plugin code is complete and ready to run the moment PHP + MySQL are available; it just can't be executed or migrated until then.

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
