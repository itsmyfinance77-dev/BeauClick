<?php
/**
 * Router for PHP's built-in dev server (`php -S`), which has no .htaccess /
 * mod_rewrite support — without this, every pretty permalink (/marketplace/,
 * /dashboard/, /professional/42/, etc.) 404s or silently falls back to the
 * front page instead of reaching WordPress's own URL parsing in index.php.
 * Real hosting (Apache/Nginx) doesn't need this file; it's dev-server-only.
 */

$path = urldecode( parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH ) );

// is_dir() matters as much as is_file() here: a request for /wp-admin/
// (or any other real directory with its own index.php, e.g. wp-admin
// itself) must be handed back to PHP's built-in server so IT resolves
// the directory's index.php — checking is_file() alone made every
// directory request fall through to the site's own front-end index.php
// instead, silently bouncing wp-admin to the homepage.
if ( '/' !== $path && ( is_file( __DIR__ . $path ) || is_dir( __DIR__ . $path ) ) ) {
	return false;
}

require __DIR__ . '/index.php';
