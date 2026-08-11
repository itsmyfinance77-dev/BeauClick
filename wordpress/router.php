<?php
/**
 * Router for PHP's built-in dev server (`php -S`), which has no .htaccess /
 * mod_rewrite support — without this, every pretty permalink (/marketplace/,
 * /dashboard/, /professional/42/, etc.) 404s or silently falls back to the
 * front page instead of reaching WordPress's own URL parsing in index.php.
 * Real hosting (Apache/Nginx) doesn't need this file; it's dev-server-only.
 */

$path = urldecode( parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH ) );

if ( '/' !== $path && is_file( __DIR__ . $path ) ) {
	return false;
}

require __DIR__ . '/index.php';
